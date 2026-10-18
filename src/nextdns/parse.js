// -----------------------------------------------------------------------------
// Answers of the NextDNS API -> plain objects (pure). Each function returns
// null when the answer is not what the API documents, never throws.
//
//   GET /profiles                          [{ id, fingerprint, name }]
//   GET /profiles/:id/analytics/status     [{ status, queries }]  default | blocked | allowed | relayed
//   GET /profiles/:id/analytics/encryption [{ encrypted, queries }]
//   GET /profiles/:id/analytics/devices    [{ id, name, model, localIp?, queries }]
//
// The ratios follow the nextdns library 5.1.0: blocked / all, encrypted /
// (encrypted + unencrypted), in percent with one decimal, 0 without queries.
// -----------------------------------------------------------------------------

import { PROFILE_ID_PATTERN } from '../constants.js';

const count = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

/** Percentage with one decimal, 0 when there is nothing to divide. */
export const ratio = (part, total) => (total > 0 ? Math.round((part / total) * 1000) / 10 : 0);

/** The `data` of an answer envelope `{ data, meta }`. */
export const dataOf = (json) =>
  json !== null && typeof json === 'object' && !Array.isArray(json) && 'data' in json
    ? json.data
    : undefined;

export function parseProfiles(json) {
  const data = dataOf(json);
  if (!Array.isArray(data)) return null;
  const profiles = [];
  const seen = new Set();
  for (const item of data) {
    const id = typeof item?.id === 'string' ? item.id : null;
    if (!id || !PROFILE_ID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    const name = typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id;
    profiles.push({ id, name: name.slice(0, 100) });
  }
  return profiles;
}

export function parseStatus(json) {
  const data = dataOf(json);
  if (!Array.isArray(data)) return null;
  let total = 0;
  let blocked = 0;
  for (const item of data) {
    const queries = count(item?.queries);
    if (queries === null || typeof item?.status !== 'string') continue;
    total += queries;
    if (item.status === 'blocked') blocked += queries;
  }
  return { total, blocked, blockedRatio: ratio(blocked, total) };
}

export function parseEncryption(json) {
  const data = dataOf(json);
  if (!Array.isArray(data)) return null;
  let total = 0;
  let encrypted = 0;
  for (const item of data) {
    const queries = count(item?.queries);
    if (queries === null || typeof item?.encrypted !== 'boolean') continue;
    total += queries;
    if (item.encrypted) encrypted += queries;
  }
  return { total, encrypted, encryptedRatio: ratio(encrypted, total) };
}

/** The devices seen (unidentified ones left out), and whether a next page exists. */
export function parseDevices(json) {
  const data = dataOf(json);
  if (!Array.isArray(data)) return null;
  const ids = new Set();
  for (const item of data) {
    if (typeof item?.id !== 'string' || !item.id || item.id === '__UNIDENTIFIED__') continue;
    if ((count(item.queries) ?? 0) === 0) continue;
    ids.add(item.id);
  }
  const cursor = json?.meta?.pagination?.cursor;
  return { count: ids.size, more: typeof cursor === 'string' && cursor !== '' };
}

/** A profile answer: its `data` object, or null. */
export function parseProfile(json) {
  const data = dataOf(json);
  return data !== null && typeof data === 'object' && !Array.isArray(data) ? data : null;
}
