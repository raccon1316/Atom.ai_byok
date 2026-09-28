// events.js — funnel analytics for the install→activation→retention funnel.
// Extension SW + Node-testable. Storage-backed, no network, single key.
// Tracks: install (first-run flag), card started/succeeded/failed per feature
// (battlecard, multitab), first_card_generated, second_card_week2,
// trigger_banner_shown, trigger_banner_clicked.
// Analytics.getFunnelStats() returns per-feature counts + funnel conversion +
// cohort view (install week actives vs following-week returners).

export const ANALYTICS_KEY = 'analytics';
export const LAUNCH_METRICS_KEY = 'launchMetrics';
export const MAX_EVENTS = 200;
export const DAY_MS = 24 * 3600 * 1000;

// deal_room_used is reserved (deal room not built for v1); fired nowhere yet.
export const EVENT_TYPES = [
  'install',
  'card_started',
  'card_succeeded',
  'card_failed',
  'first_card_generated',
  'second_card_week2',
  'trigger_banner_shown',
  'trigger_banner_clicked',
  'shared',
  'deal_room_used',
];

function defaultState() {
  return {
    installTs: 0,
    firstCardTs: 0,
    secondWeek2Ts: 0,
    perFeature: {
      battlecard: { started: 0, succeeded: 0, failed: 0 },
      multitab: { started: 0, succeeded: 0, failed: 0 },
      dealroom: { started: 0, succeeded: 0, failed: 0 },
    },
    bannerShown: 0,
    bannerClicked: 0,
    weeklyActivity: [],
    events: [],
  };
}

export function isoWeekKey(ts) {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  const thursday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((thursday - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function normalizeFeature(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('battle')) return 'battlecard';
  if (s.includes('multi')) return 'multitab';
  if (s.includes('deal')) return 'dealroom';
  return null;
}

export class Analytics {
  // storage: chrome.storage.local-like {get(keys)->obj, set(obj)}; now: () => ms
  constructor({ storage, now } = {}) {
    if (!storage?.get || !storage?.set) throw new Error('Analytics needs storage {get,set}');
    this.storage = storage;
    this.now = typeof now === 'function' ? now : () => Date.now();
  }

  async _load() {
    try {
      const data = await this.storage.get([ANALYTICS_KEY]);
      const s = data?.[ANALYTICS_KEY];
      if (s && typeof s === 'object') return { ...defaultState(), ...s };
    } catch (e) {}
    return defaultState();
  }

  async _save(state) {
    await this.storage.set({ [ANALYTICS_KEY]: state });
    return state;
  }

  async track(type, props = {}) {
    if (!EVENT_TYPES.includes(type)) throw new Error(`unknown event: ${type}`);
    const state = await this._load();
    const ts = this.now();
    // install is a first-run flag: ignore duplicates (e.g. onInstalled on update).
    if (type === 'install' && state.installTs) {
      await this._save(state);
      return state;
    }
    state.events.push({ type, ts, props });
    if (state.events.length > MAX_EVENTS) state.events = state.events.slice(-MAX_EVENTS);
    const week = isoWeekKey(ts);
    if (!state.weeklyActivity.includes(week)) state.weeklyActivity.push(week);

    if (type === 'install' && !state.installTs) state.installTs = ts;
    if (type === 'trigger_banner_shown') state.bannerShown += 1;
    if (type === 'trigger_banner_clicked') state.bannerClicked += 1;

    const feature = normalizeFeature(props.jobType || props.feature);
    // tolerate legacy states that predate a feature bucket
    if (feature && !state.perFeature[feature]) state.perFeature[feature] = { started: 0, succeeded: 0, failed: 0 };
    if (type === 'card_started' && feature) state.perFeature[feature].started += 1;
    if (type === 'card_succeeded' && feature) {
      state.perFeature[feature].succeeded += 1;
      if (!state.firstCardTs) {
        state.firstCardTs = ts;
        state.events.push({ type: 'first_card_generated', ts, props });
      } else if (!state.secondWeek2Ts && isoWeekKey(ts) !== isoWeekKey(state.firstCardTs)) {
        state.secondWeek2Ts = ts;
        state.events.push({ type: 'second_card_week2', ts, props });
      }
    }
    if (type === 'card_failed' && feature) state.perFeature[feature].failed += 1;

    await this._save(state);
    return state;
  }

  async trackInstall() { return this.track('install'); }
  async trackCardStarted(jobType) { return this.track('card_started', { jobType }); }
  async trackCardDone(jobType) { return this.track('card_succeeded', { jobType }); }
  async trackCardFailed(jobType) { return this.track('card_failed', { jobType }); }
  async trackEvent(type, props = {}) { return this.track(type, props); }

  // Phase 9: launch report — 7-day rolling view, persisted to `launchMetrics`
  // (exportable via Settings → Export All Data). Rolls up events + triageLog.
  async getLaunchReport() {
    const state = await this._load();
    const now = this.now();
    const cut7 = now - 7 * DAY_MS;
    const ev7 = state.events.filter((e) => e.ts >= cut7);
    const count = (arr, t) => arr.filter((e) => e.type === t).length;

    const installs7 = count(ev7, 'install');
    const firstCards7 = count(ev7, 'first_card_generated');
    const secondCards7 = count(ev7, 'second_card_week2');
    const shown7 = count(ev7, 'trigger_banner_shown');
    const clicked7 = count(ev7, 'trigger_banner_clicked');
    const shared7 = count(ev7, 'shared');
    const firstCardsAll = count(state.events, 'first_card_generated');
    const secondCardsAll = count(state.events, 'second_card_week2');

    // error_rate per feature (failed / started) — all-time + 7d
    const errorRate = {};
    const errorRate7 = {};
    for (const [feat, v] of Object.entries(state.perFeature)) {
      errorRate[feat] = v.started ? v.failed / v.started : 0;
      errorRate7[feat] = null;
    }
    const featStarted7 = {}; const featFailed7 = {};
    for (const e of ev7) {
      const f = normalizeFeature(e.props?.jobType || e.props?.feature);
      if (!f) continue;
      if (e.type === 'card_started') featStarted7[f] = (featStarted7[f] || 0) + 1;
      if (e.type === 'card_failed') featFailed7[f] = (featFailed7[f] || 0) + 1;
    }
    for (const feat of Object.keys(state.perFeature)) {
      errorRate7[feat] = featStarted7[feat] ? featFailed7[feat] / featStarted7[feat] : null;
    }

    // top failure modes from triageLog (last 24h)
    let topFailureModes = [];
    let triageRecent = 0;
    try {
      const t = await this.storage.get(['triageLog']);
      const log = Array.isArray(t?.triageLog) ? t.triageLog : [];
      const cut24 = now - DAY_MS;
      const recent = log.filter((e) => e.ts >= cut24);
      triageRecent = recent.length;
      const bySig = {};
      for (const e of recent) bySig[e.signature] = (bySig[e.signature] || 0) + 1;
      topFailureModes = Object.entries(bySig).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([signature, count]) => ({ signature, count }));
    } catch (e) {}

    const report = {
      date: new Date(now).toISOString().slice(0, 10),
      windowDays: 7,
      installs7,
      firstCards7,
      activationPct: installs7 ? firstCards7 / installs7 : 0,
      firstCardsAll,
      secondCardsAll,
      retentionPct: firstCardsAll ? secondCardsAll / firstCardsAll : 0,
      trigger: { shown7, clicked7, ctr7: shown7 ? clicked7 / shown7 : 0 },
      shared7,
      errorRate,
      errorRate7,
      topFailureModes,
      triageRecent24h: triageRecent,
      eventCount7: ev7.length,
    };
    try { await this.storage.set({ [LAUNCH_METRICS_KEY]: report }); } catch (e) {}
    return report;
  }

  async getFunnelStats() {
    const state = await this._load();
    const installWeek = state.installTs ? isoWeekKey(state.installTs) : null;
    const week1Active = installWeek ? state.weeklyActivity.includes(installWeek) : false;
    // week-2 returner: activity in any week after the install week
    const week2Returned = installWeek
      ? state.weeklyActivity.some((w) => w > installWeek)
      : false;
    const firstSession = !!(state.installTs && state.firstCardTs && (state.firstCardTs - state.installTs) <= 24 * 3600 * 1000);
    const totalStarted = Object.values(state.perFeature).reduce((n, v) => n + (v?.started || 0), 0);
    const totalSucceeded = Object.values(state.perFeature).reduce((n, v) => n + (v?.succeeded || 0), 0);
    return {
      installTs: state.installTs,
      hasInstalled: !!state.installTs,
      firstCardTs: state.firstCardTs,
      secondWeek2Ts: state.secondWeek2Ts,
      firstSession,
      week2Return: !!state.secondWeek2Ts,
      perFeature: JSON.parse(JSON.stringify(state.perFeature)),
      totals: { started: totalStarted, succeeded: totalSucceeded },
      banner: {
        shown: state.bannerShown,
        clicked: state.bannerClicked,
        ctr: state.bannerShown ? state.bannerClicked / state.bannerShown : 0,
      },
      cohorts: {
        installWeek,
        weeklyActivity: [...state.weeklyActivity],
        week1Active,
        week2Returned,
      },
      eventCount: state.events.length,
    };
  }
}
