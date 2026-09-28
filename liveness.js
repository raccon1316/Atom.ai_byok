// liveness.js — Phase 7 storage-write keepalive for the MV3 service worker.
// Imported by background.js; also imported by qa/test-liveness.mjs with mocks.
//
// Why: Chrome clamps chrome.alarms to >=30s (dev/unpacked) and longer in
// release builds, so a 25s heartbeat request may fire at 60s+. MV3 kills an
// idle SW after ~30s, which would kill a job running with the popup closed.
// Fix: while a job runs, write alternating liveness keys every ~20s. Each
// chrome.storage.local.set() is itself API activity that resets the SW idle
// timer — the writes (not any listener) are the keepalive. Two keys alternate
// so every write is a value change: observable by OTHER contexts (popup via
// storage.onChanged) and never coalesced as a same-value write. Note: Chrome
// does not fire onChanged in the context that made the write, so the SW's own
// onChanged listener is a no-op observer — harmless, kept for cross-context
// symmetry. The alarm remains as backup.

export const LIVENESS_KEYS = ['jobLivenessA', 'jobLivenessB'];
export const LIVENESS_MS = 20000;

// Badge mapping (notifications audit: chrome.action needs no permission).
// status: 'done' | 'failed' | anything-else -> {text, color}
export function badgeForStatus(status) {
  if (status === 'done') return { text: '✓', color: '#0a7d4b' };
  if (status === 'failed') return { text: '!', color: '#b3261e' };
  return { text: '', color: null };
}

export function createLiveness({ storage, intervalMs = LIVENESS_MS, onTick } = {}) {
  if (!storage?.set) throw new Error('createLiveness needs a storage with .set()');
  let timer = null;
  let toggle = false;
  let jobId = null;

  const tick = async () => {
    toggle = !toggle;
    const key = toggle ? LIVENESS_KEYS[0] : LIVENESS_KEYS[1];
    await storage.set({ [key]: { jobId, ts: Date.now() } });
    if (typeof onTick === 'function') onTick({ key, jobId });
    return key;
  };

  return {
    poke: tick,
    start(id) {
      jobId = id;
      if (timer) return;
      tick().catch(() => {});
      timer = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      if (timer?.unref) { try { timer.unref(); } catch (e) {} }
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      jobId = null;
      try { storage.remove?.(LIVENESS_KEYS); } catch (e) {}
    },
    tick,
    get state() { return { running: !!timer, jobId, toggle }; },
  };
}

// Simulates MV3 lifetime under a clamped alarm to prove the fallback.
// - jobDurationMs: how long the job needs.
// - idleTimeoutMs: SW dies if no keepalive (storage write or alarm) within this.
// - alarmEveryMs: clamped alarm interval (backup only).
// - livenessEveryMs: storage-write interval, or null for alarm-only.
// Returns {completed, keepalives, alarms, diedAt}.
export async function simulateJobLifetime({ jobDurationMs, idleTimeoutMs, alarmEveryMs, livenessEveryMs }) {
  let lastKeepalive = 0;
  let keepalives = 0;
  let alarms = 0;
  let diedAt = null;
  let completed = false;
  const t0 = Date.now();
  const now = () => Date.now() - t0;

  const alarmTimer = setInterval(() => { alarms++; lastKeepalive = now(); }, alarmEveryMs);
  let liveTimer = null;
  if (livenessEveryMs != null) {
    const ltick = () => { keepalives++; lastKeepalive = now(); };
    ltick();
    liveTimer = setInterval(ltick, livenessEveryMs);
  }
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (now() - lastKeepalive > idleTimeoutMs) {
        diedAt = now();
        clearInterval(check); clearInterval(alarmTimer);
        if (liveTimer) clearInterval(liveTimer);
        resolve();
      } else if (now() >= jobDurationMs) {
        completed = true;
        clearInterval(check); clearInterval(alarmTimer);
        if (liveTimer) clearInterval(liveTimer);
        resolve();
      }
    }, 5);
  });
  return { completed, keepalives, alarms, diedAt };
}
