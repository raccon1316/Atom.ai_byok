// triage.js — failure capture + signature classification for the soft launch.
// Any job failure is captured as {feature, signature, error, urls, tokensUsed, ts}
// and appended to `triageLog` (cap 100, newest first). The popup shows a gentle
// banner when the SAME signature appears >= BANNER_THRESHOLD times in 24h.
// Node-testable (storage via {get,set}); wired in background.js.

export const TRIAGE_KEY = 'triageLog';
export const MAX_TRIAGE = 100;
export const BANNER_THRESHOLD = 3;
export const BANNER_WINDOW_MS = 24 * 3600 * 1000;

// Failure signatures and the fix each implies (see qa/triage.md playbook).
export const SIGNATURES = [
  'rate_limit',
  'parse_fail',
  'empty_page',
  'timeout',
  'host_permission',
  'network',
  'unknown',
];

export function signatureOf(error) {
  const s = String(error || '').toLowerCase();
  if (/rate\s*limit|429|too many requests|quota/i.test(s)) return 'rate_limit';
  if (/parse|json|unparseable|unexpected token/i.test(s)) return 'parse_fail';
  if (/empty|no (readable )?text|not enough readable|unreadable|readable text/i.test(s)) return 'empty_page';
  if (/timeout|timed out|did not complete/i.test(s)) return 'timeout';
  if (/host permission|not granted|access to read/i.test(s)) return 'host_permission';
  if (/network|fetch failed|failed to open|err_|socket|offline/i.test(s)) return 'network';
  return 'unknown';
}

export class Triage {
  constructor({ storage, now } = {}) {
    if (!storage?.get || !storage?.set) throw new Error('Triage needs storage {get,set}');
    this.storage = storage;
    this.now = typeof now === 'function' ? now : () => Date.now();
  }

  async _load() {
    try {
      const data = await this.storage.get([TRIAGE_KEY]);
      const list = data?.[TRIAGE_KEY];
      if (Array.isArray(list)) return list;
    } catch (e) {}
    return [];
  }

  async _save(list) {
    await this.storage.set({ [TRIAGE_KEY]: list });
    return list;
  }

  async capture({ feature, error, urls, tokensUsed } = {}) {
    const signature = signatureOf(error);
    const entry = {
      feature: String(feature || 'unknown'),
      signature,
      error: String(error || '').slice(0, 300),
      urls: (Array.isArray(urls) ? urls : []).slice(0, 5),
      tokensUsed: Number(tokensUsed || 0),
      ts: this.now(),
    };
    const list = await this._load();
    list.unshift(entry);
    if (list.length > MAX_TRIAGE) list.length = MAX_TRIAGE;
    await this._save(list);
    return entry;
  }

  async summary() {
    const list = await this._load();
    const cutoff = this.now() - BANNER_WINDOW_MS;
    const recent = list.filter((e) => e.ts >= cutoff);
    const bySignature = {};
    for (const e of recent) bySignature[e.signature] = (bySignature[e.signature] || 0) + 1;
    const top = Object.entries(bySignature).sort((a, b) => b[1] - a[1])[0];
    return {
      total: list.length,
      recent24h: recent.length,
      bySignature,
      top3: Object.entries(bySignature).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([signature, count]) => ({ signature, count })),
      banner: top && top[1] >= BANNER_THRESHOLD ? { signature: top[0], count: top[1] } : null,
    };
  }
}