// hubspot.js — Feature 7: push a brief onto a HubSpot company record.
//
// Pure and fetch-injected: every network call goes through the `fetchImpl`
// the caller hands in, so the whole push flow runs in Node tests. The popup
// calls pushBriefToHubSpot() with the global fetch and chrome.storage.local.
//
// Flow: search companies by name → reuse or create → create a note →
// associate note→company → resolve a deep link. The portal id for the deep
// link comes from the private-app token introspection endpoint and is cached
// (storage injected); when it cannot be resolved the result carries a generic
// contacts URL instead of a dead link.

const HS_BASE = 'https://api.hubapi.com';
export const PORTAL_CACHE_KEY = 'hubspotPortalId';
export const NOTE_TO_COMPANY_ASSOCIATION_TYPE_ID = 279; // HUBSPOT_DEFINED: note → company

export function buildNoteBody(topic, report) {
  return `${topic} — Atom.AI brief (${new Date().toLocaleString()})\n\n${String(report || '')}`.substring(0, 6000);
}

export function hubspotErrorFor(status, detail = '') {
  if (status === 401) return 'HubSpot token expired or invalid. Regenerate it in your HubSpot account.';
  if (status === 403) return 'Token missing write permissions. Re-create with companies + notes write scope.';
  return `HubSpot request failed (${status})${detail ? ': ' + detail : ''}`;
}

async function hsFetch(fetchImpl, token, path, opts = {}) {
  let res;
  try {
    res = await fetchImpl(`${HS_BASE}${path}`, {
      method: opts.method || 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw new Error('Network error reaching HubSpot. Check your connection — if it persists, grant host access in Settings.');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(hubspotErrorFor(res.status));
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.message || ''; } catch (e) { /* body may be empty */ }
    throw new Error(hubspotErrorFor(res.status, String(detail).substring(0, 200)));
  }
  if (res.status === 204) return {};
  return await res.json().catch(() => ({}));
}

export async function searchCompany(fetchImpl, token, companyName) {
  const path = `/crm/v3/objects/companies?search=${encodeURIComponent(companyName)}&properties=name&limit=5`;
  const data = await hsFetch(fetchImpl, token, path);
  const first = data?.results?.[0];
  return first ? { id: String(first.id), name: first.properties?.name || companyName } : null;
}

export async function createCompany(fetchImpl, token, companyName) {
  const data = await hsFetch(fetchImpl, token, '/crm/v3/objects/companies', {
    method: 'POST',
    body: { properties: { name: companyName } },
  });
  return { id: String(data.id), name: companyName };
}

export async function createNote(fetchImpl, token, noteBody) {
  const data = await hsFetch(fetchImpl, token, '/crm/v3/objects/notes', {
    method: 'POST',
    body: { properties: { hs_note_body: noteBody, hs_timestamp: Date.now() } },
  });
  return String(data.id);
}

export async function associateNoteToCompany(fetchImpl, token, noteId, companyId) {
  await hsFetch(fetchImpl, token, `/crm/v3/objects/notes/${noteId}/associations/default`, {
    method: 'PUT',
    body: {
      toObjectId: Number(companyId),
      associationCategory: 'HUBSPOT_DEFINED',
      associationTypeId: NOTE_TO_COMPANY_ASSOCIATION_TYPE_ID,
    },
  });
}

export async function fetchPortalId(fetchImpl, token, storage) {
  if (storage) {
    try {
      const cached = await storage.get([PORTAL_CACHE_KEY]);
      if (Number(cached?.[PORTAL_CACHE_KEY]) > 0) return { portalId: Number(cached[PORTAL_CACHE_KEY]), fromCache: true };
    } catch (e) { /* cache read failure = cache miss */ }
  }
  let portalId = null;
  try {
    // Private-app tokens expose their own portal via token introspection.
    const res = await fetchImpl(`${HS_BASE}/oauth/v3/access-tokens/${encodeURIComponent(token)}`);
    if (res.ok) portalId = Number((await res.json().catch(() => ({})))?.portalId) || null;
  } catch (e) { /* fall through to the generic link */ }
  if (portalId && storage) {
    try { await storage.set({ [PORTAL_CACHE_KEY]: portalId }); } catch (e) { /* best effort */ }
  }
  return { portalId, fromCache: false };
}

export function companyUrl(portalId, companyId) {
  if (Number(portalId) > 0) return `https://app.hubspot.com/contacts/${portalId}/company/${companyId}`;
  // Without a portal id any record URL would be dead — the picker still lands
  // the user inside their account.
  return 'https://app.hubspot.com/contacts/';
}

export async function pushBriefToHubSpot({
  fetchImpl = globalThis.fetch,
  storage = null,
  token,
  companyName,
  noteBody,
} = {}) {
  const name = String(companyName || '').trim();
  if (!token || !token.trim()) {
    throw new Error('HubSpot not configured. Add your token in Settings → CRM.');
  }
  if (!name) throw new Error('Enter a company name to push to.');

  const t = token.trim();
  const existing = await searchCompany(fetchImpl, t, name);
  const company = existing || await createCompany(fetchImpl, t, name);
  const noteId = await createNote(fetchImpl, t, noteBody);
  await associateNoteToCompany(fetchImpl, t, noteId, company.id);
  const { portalId } = await fetchPortalId(fetchImpl, t, storage);
  return {
    companyId: company.id,
    companyCreated: !existing,
    url: companyUrl(portalId, company.id),
    deepLink: Number(portalId) > 0,
  };
}
