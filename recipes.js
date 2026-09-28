// recipes.js — Phase 6: save/replay/self-heal grounded action sequences.
// Pure + dependency-free (Node-testable). Stores recipes as fingerprint matchers
// so they survive SPA re-renders. Cap: 20 recipes.

import { descriptorFor, reground, normalizeName } from './grounding.js';
import { regroundRef } from './recovery.js';

export const RECIPES_KEY = 'autoTaskRecipes';
export const RECIPES_CAP = 20;

export async function saveRecipe(store, recipe) {
  const list = await readRecipes(store);
  const entry = {
    recipeId: recipe.recipeId || `r${Date.now().toString(36)}`,
    name: String(recipe.name || 'Unnamed Recipe').slice(0, 80),
    goal: String(recipe.goal || '').slice(0, 500),
    steps: (recipe.steps || []).map(stepToDescriptor).filter(Boolean),
    createdAt: Date.now(),
    lastRun: null,
    runCount: 0
  };
  list.push(entry);
  await writeBounded(store, RECIPES_KEY, list, RECIPES_CAP);
  return entry;
}

// Actions that are safe to replay purely from refs (grounded, no LLM).
const REF_ACTIONS = ['clickRef', 'typeRef', 'selectRef', 'hoverRef', 'scrollRef', 'pressKey'];
// Actions that need page READING (an LLM) and therefore cannot run during a
// zero-LLM replay. They are preserved as descriptor-less markers so replayRecipe
// can recognise them and hand the step to the agent, rather than the saver
// silently deleting them (which would make the fallback unobservable).
const AGENT_ACTIONS = ['snapshot', 'extractTable', 'readPage'];

export function stepToDescriptor(step) {
  if (!step || !step.action) return null;
  const { action, params, observation, snapshotHash } = step;
  
  if (AGENT_ACTIONS.includes(action)) {
    // Keep it (no descriptor/ref) purely so replay can route it honestly.
    return {
      action,
      params: { ...(params || {}) },
      descriptor: null,
      observation: String(observation || '').slice(0, 300),
      snapshotHash
    };
  }
  if (!REF_ACTIONS.includes(action)) return null;
  
  // Store as descriptor for re-grounding on replay
  const desc = {
    action,
    params: { ...params },
    descriptor: params.ref ? { ref: params.ref, action } : null,
    observation: String(observation || '').slice(0, 300),
    snapshotHash
  };
  return desc;
}

export async function readRecipes(store) {
  const data = await store.get(RECIPES_KEY);
  const list = data && data[RECIPES_KEY];
  return Array.isArray(list) ? list : [];
}

export async function getRecipe(store, recipeId) {
  const list = await readRecipes(store);
  return list.find(r => r.recipeId === recipeId) || null;
}

export async function listRecipes(store) {
  const list = await readRecipes(store);
  return list.map(r => ({
    recipeId: r.recipeId,
    name: r.name,
    goal: r.goal,
    stepCount: r.steps?.length || 0,
    createdAt: r.createdAt,
    lastRun: r.lastRun,
    runCount: r.runCount
  })).reverse();
}

export async function deleteRecipe(store, recipeId) {
  const list = await readRecipes(store);
  const filtered = list.filter(r => r.recipeId !== recipeId);
  await writeBounded(store, RECIPES_KEY, filtered, RECIPES_CAP);
  return filtered.length !== list.length;
}

export async function renameRecipe(store, recipeId, name) {
  const list = await readRecipes(store);
  const recipe = list.find(r => r.recipeId === recipeId);
  if (!recipe) return false;
  recipe.name = String(name || '').slice(0, 80);
  await writeBounded(store, RECIPES_KEY, list, RECIPES_CAP);
  return true;
}

async function writeBounded(store, key, list, cap) {
  const trimmed = list.length > cap ? list.slice(list.length - cap) : list;
  await store.set({ [key]: trimmed });
}

// ---- Recipe replay with self-healing ----

export async function replayRecipe(agentTools, tabId, recipe, deps = {}) {
  const steps = recipe.steps || [];
  if (!steps.length) return { ok: false, reason: 'NO_STEPS' };
  
  const results = [];
  let healed = false;
  
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const { action, params, descriptor, snapshotHash } = step;
    
    // Re-ground the ref if we have a descriptor
    let currentParams = { ...params };
    if (descriptor?.ref && descriptor.action === action) {
      const freshSnap = await agentTools.snapshot(tabId);
      if (freshSnap.byRef) {
        const newRef = regroundRef(
          { byRef: { [descriptor.ref]: { ...descriptor } } }, // minimal prev snapshot
          descriptor.ref,
          freshSnap,
          { crossRole: false }
        );
        if (newRef) {
          currentParams = { ...params, ref: newRef };
          healed = true;
        }
      }
    }
    
    // Execute the action
    let res = null;
    switch (action) {
      case 'clickRef': res = await agentTools.clickRef(tabId, currentParams.ref); break;
      case 'typeRef': res = await agentTools.typeRef(tabId, currentParams.ref, currentParams.text, { clear: currentParams.clear, submit: currentParams.submit }); break;
      case 'selectRef': res = await agentTools.selectRef(tabId, currentParams.ref, currentParams.option); break;
      case 'hoverRef': res = await agentTools.hoverRef(tabId, currentParams.ref); break;
      case 'scrollRef': res = await agentTools.scrollRef(tabId, currentParams.ref); break;
      case 'pressKey': res = await agentTools.pressKey(tabId, currentParams.key); break;
      // 'snapshot' is a no-op for self-healing (there is no ref to reground); it
      // exists so a built-in's leading perception step doesn't abort the replay.
      case 'snapshot': {
        const snap = await agentTools.snapshot(tabId);
        if (!snap || !snap.byRef) {
          res = { ok: false, reason: 'SNAPSHOT_FAILED' };
        } else {
          res = { ok: true, observation: 'snapshot taken', refs: Object.keys(snap.byRef).length };
        }
        break;
      }
      // 'extractTable' and 'readPage' need page reading, which is an LLM task.
      // Calling the LLM here would defeat zero-LLM replay, so we refuse honestly
      // and let the existing failure path hand the step to the full agent.
      case 'extractTable':
      case 'readPage':
        res = { ok: false, reason: 'NEEDS_AGENT' };
        break;
      default: res = { ok: false, reason: 'UNKNOWN_ACTION' };
    }
    
    const observation = res?.observation || (res?.ok ? 'ok' : `EFFECT_FAILED (${res?.reason || 'unknown'})`);
    results.push({ step: i + 1, action, params: currentParams, ok: res?.ok === true, observation, healed: healed && i === 0 });
    
    // Self-healing: if action failed, try full agent from this step. If no
    // fallback is wired, the replay must NOT report success — a failed step that
    // is skipped over and then returns ok:true is a fabricated result.
    if (!res?.ok) {
      if (deps.onFailure) {
        const fallback = await deps.onFailure({ recipe, failedStep: i, reason: res?.reason });
        if (fallback?.ok) return { ok: true, results, healed: true, fallback };
        return { ok: false, results, reason: res?.reason, healed };
      }
      return { ok: false, results, reason: res?.reason, healed };
    }
  }

  return { ok: true, results, healed };
}

// Built-in seed recipes.
//
// NOTE on the extractTable / readPage steps below: both need page reading, which
// is an LLM task, so replayRecipe deliberately refuses them with NEEDS_AGENT and
// hands the step to the full agent loop. These recipes therefore always fall back
// to the agent for the reading step — that is honest behaviour, not a broken
// replay, and it keeps the ref-based steps before it genuinely zero-LLM.
export const BUILTIN_RECIPES = [
  {
    name: 'Extract pricing table',
    goal: 'Extract the pricing table from the current page as structured data',
    steps: [
      { action: 'snapshot', params: {} },
      { action: 'clickRef', params: { ref: 'e1', targetDescription: 'pricing table' } },
      { action: 'extractTable', params: {} }
    ]
  },
  {
    name: 'Summarize page',
    goal: 'Create a concise summary of the current page',
    steps: [
      { action: 'snapshot', params: {} },
      { action: 'readPage', params: { mode: 'full' } }
    ]
  }
];

export async function seedBuiltinRecipes(store) {
  const existing = await readRecipes(store);
  if (existing.length > 0) return existing; // Already seeded
  
  for (const recipe of BUILTIN_RECIPES) {
    await saveRecipe(store, recipe);
  }
  return readRecipes(store);
}