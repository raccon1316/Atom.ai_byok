// structured.js — the one shared path for AI calls whose output must be
// structured JSON (email variants, objection strategies, MEDDIC scores,
// transcript analysis). Every consumer gets: JSON-mode request where the
// provider supports it, robust extraction of the JSON object from whatever
// wrapper the model adds, caller-supplied validation, and exactly ONE repair
// round-trip before failing with an honest, retryable error. No consumer ever
// shows a raw JSON.parse stack trace to a user mid-sales-call.

export const JSON_SYSTEM_PROMPT =
  'You are a JSON API. Respond with exactly ONE valid JSON object and nothing else. ' +
  'No markdown fences, no commentary, no text before or after the JSON.';

// Pull the outermost JSON object/array out of a model reply. Models wrap JSON
// in ```fences``` or lead with a sentence despite the system prompt; both are
// routine, so both are handled here rather than in five call sites.
export function extractJSON(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const unfenced = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  for (const candidate of [unfenced, s]) {
    const starts = [candidate.indexOf('{'), candidate.indexOf('[')].filter((i) => i >= 0);
    if (!starts.length) continue;
    const start = Math.min(...starts);
    const open = candidate[start];
    const close = open === '{' ? '}' : ']';
    const end = candidate.lastIndexOf(close);
    if (end > start) return candidate.slice(start, end + 1);
  }
  return null;
}

export function parseModelJSON(text) {
  const raw = extractJSON(text);
  if (!raw) return { ok: false, error: 'No JSON object found in the response.' };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, error: `Invalid JSON: ${e.message}` };
  }
}

// validate(value) may return true/nothing (pass), { ok: false, error } (fail),
// or throw (fail) — all three shapes are normalized to an error string or null.
function validateOrError(validate, value) {
  if (typeof validate !== 'function') return null;
  try {
    const res = validate(value);
    if (res === true || res == null) return null;
    if (res && res.ok === true) return null;
    return String((res && res.error) || 'Response failed validation.');
  } catch (e) {
    return e.message;
  }
}

function looksLikeJSONModeRejection(err) {
  return /response_format|json_object|json mode/i.test(String(err && err.message));
}

export async function requestJSON(ai, {
  prompt,
  maxTokens = 900,
  temperature = 0.3,
  retries = 1,
  timeoutMs,
  validate,
  onProgress,
} = {}) {
  if (!ai || typeof ai.requestCompletion !== 'function') {
    throw new Error('requestJSON needs an AI instance.');
  }

  const call = (userContent, json) =>
    ai.requestCompletion({
      messages: [
        { role: 'system', content: JSON_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      maxTokens,
      temperature,
      retries,
      timeoutMs,
      json,
      onProgress,
    });

  let text;
  try {
    text = await call(prompt, true);
  } catch (e) {
    // Some models reject response_format outright; a prompt-only retry keeps
    // JSON mode an optimization, never a requirement.
    if (!looksLikeJSONModeRejection(e)) throw e;
    text = await call(prompt, false);
  }

  let parsed = parseModelJSON(text);
  let problem = parsed.ok ? validateOrError(validate, parsed.value) : parsed.error;
  if (!problem) return parsed.value;

  const repairPrompt =
    `Your previous reply was not usable.\nProblem: ${problem}\n` +
    `Previous reply (truncated):\n${String(text).slice(0, 1500)}\n\n` +
    `Return the corrected JSON object only, following the original instructions:\n\n${String(prompt).slice(0, 6000)}`;

  text = await call(repairPrompt, false);
  parsed = parseModelJSON(text);
  problem = parsed.ok ? validateOrError(validate, parsed.value) : parsed.error;
  if (!problem) return parsed.value;

  throw new Error('The AI returned malformed results. Please try again.');
}
