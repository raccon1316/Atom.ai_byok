// winloss.js — Win/Loss capture for battle cards.
// Pure + dependency-free: works in extension SW and in Node tests.
// Storage key: 'winloss' in chrome.storage.local
// Shape: [{ competitor, outcome: 'won'|'lost', why, date, cardVersion }]

export const WINLOSS_KEY = 'winloss';

export function defaultState() {
  return [];
}

export async function getWinLoss(storage) {
  try {
    const data = await storage.get([WINLOSS_KEY]);
    const list = data?.[WINLOSS_KEY];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

export async function saveWinLoss(storage, list) {
  const capped = list.slice(-500); // keep last 500 entries
  await storage.set({ [WINLOSS_KEY]: capped });
  return capped;
}

export async function addWinLoss(storage, entry) {
  const list = await getWinLoss(storage);
  const newEntry = {
    competitor: String(entry?.competitor || '').toLowerCase().trim(),
    outcome: entry?.outcome === 'won' ? 'won' : 'lost',
    why: String(entry?.why || '').trim().substring(0, 280),
    date: entry?.date || new Date().toISOString(),
    cardVersion: String(entry?.cardVersion || '').trim(),
  };
  if (!newEntry.competitor) throw new Error('competitor required');
  list.push(newEntry);
  return saveWinLoss(storage, list);
}

export async function getHistory(storage, competitor) {
  const list = await getWinLoss(storage);
  const domain = String(competitor || '').toLowerCase().trim();
  if (!domain) return [];
  return list.filter((e) => e.competitor === domain);
}

export function getStats(records) {
  const won = records.filter((r) => r.outcome === 'won').length;
  const lost = records.filter((r) => r.outcome === 'lost').length;
  const total = won + lost;
  return { won, lost, total, winRate: total ? won / total : 0 };
}

export function formatRecord(record) {
  const d = new Date(record.date);
  const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const icon = record.outcome === 'won' ? '🟢' : '🔴';
  const why = record.why ? ` — ${record.why}` : '';
  return `${icon} ${record.outcome.toUpperCase()} on ${dateStr}${why}`;
}

// Win/Loss tally text for battle card footer
export function getTallyText(competitor, storage) {
  return getWinLoss(storage).then((list) => {
    const stats = getStats(list.filter((r) => r.competitor === competitor.toLowerCase()));
    if (stats.total === 0) return '';
    return `Your record vs ${competitor}: ${stats.won}W / ${stats.lost}L`;
  });
}

// Synthesis guidance line for card generation/regeneration (the moat):
// "Your team's history vs {competitor}: 3 wins (reps cited: pricing, onboarding),
//  1 loss (cited: enterprise features). Emphasize what wins. Address what loses."
// Returns '' when there is no history (prompt stays unchanged).
export function buildWinLossPromptLine(competitor, records) {
  const list = (Array.isArray(records) ? records : [])
    .filter((r) => String(r?.competitor || '').toLowerCase() === String(competitor || '').toLowerCase());
  if (!list.length) return '';
  const wins = list.filter((r) => r.outcome === 'won');
  const losses = list.filter((r) => r.outcome === 'lost');
  const reasons = (arr) => arr.map((r) => String(r?.why || '').trim()).filter(Boolean);
  const w = reasons(wins);
  const l = reasons(losses);
  const winPart = `${wins.length} win${wins.length === 1 ? '' : 's'}${w.length ? ` (reps cited: ${w.slice(0, 5).join(', ')})` : ''}`;
  const lossPart = `${losses.length} ${losses.length === 1 ? 'loss' : 'losses'}${l.length ? ` (cited: ${l.slice(0, 5).join(', ')})` : ''}`;
  return `Your team's history vs ${competitor}: ${winPart}, ${lossPart}. Emphasize what wins. Address what loses.`;
}