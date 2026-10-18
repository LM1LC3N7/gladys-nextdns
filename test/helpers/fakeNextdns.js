// -----------------------------------------------------------------------------
// A fake NextDNS API in memory: the requests the integration makes, with the
// answers the official documentation describes. Never checked against the
// real API (TODO.md).
// -----------------------------------------------------------------------------

import { CODES, NextDnsError } from '../../src/nextdns/errors.js';

export const API_KEY = 'f00dfeedc0ffee1234567890abcdef0123456789';

export function profileSettings({ porn = true, tiktok = true } = {}) {
  return {
    id: 'abc123',
    name: 'Home',
    fingerprint: 'fpabc',
    security: {
      threatIntelligenceFeeds: true,
      aiThreatDetection: true,
      googleSafeBrowsing: false,
      cryptojacking: true,
      dnsRebinding: true,
      idnHomographs: true,
      typosquatting: true,
      dga: true,
      nrd: false,
      ddns: false,
      parking: true,
      csam: true,
      tlds: [],
    },
    privacy: {
      blocklists: [{ id: 'nextdns-recommended' }],
      disguisedTrackers: true,
      allowAffiliate: true,
    },
    parentalControl: {
      services: [
        { id: 'tiktok', active: tiktok },
        { id: 'fortnite', active: false },
      ],
      categories: porn ? [{ id: 'porn', active: true }] : [],
      safeSearch: false,
      youtubeRestrictedMode: false,
      blockBypass: true,
    },
    settings: { logs: { enabled: true } },
  };
}

const json = (status, value, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  body: Buffer.from(JSON.stringify(value)),
});

export function createFakeNextdns() {
  const fake = {
    requests: [],
    profiles: [
      { id: 'abc123', fingerprint: 'fpabc', name: 'Home' },
      { id: 'def456', fingerprint: 'fpdef', name: 'Kids' },
    ],
    settings: {
      abc123: profileSettings(),
      def456: profileSettings({ porn: false, tiktok: false }),
    },
    status: {
      abc123: [
        { status: 'default', queries: 900 },
        { status: 'blocked', queries: 100 },
      ],
      def456: [{ status: 'default', queries: 0 }],
    },
    encryption: {
      abc123: [
        { encrypted: true, queries: 750 },
        { encrypted: false, queries: 250 },
      ],
      def456: [],
    },
    devices: {
      abc123: [
        { id: 'A1B2C', name: 'Phone', model: 'iPhone', queries: 400 },
        { id: 'D3E4F', name: 'Laptop', queries: 300 },
        { id: '__UNIDENTIFIED__', queries: 300 },
      ],
      def456: [],
    },
    /** { path (prefix), method?, status, headers?, body?, error? } answered once each. */
    failures: [],
    /** A promise the PATCH / POST wait for before answering (a slow API). */
    commandGate: null,
    /** Called with each request before it is answered. */
    onRequest: null,
    commands: [],
  };

  fake.request = async (url, options = {}) => {
    const target = new URL(url);
    const method = options.method ?? 'GET';
    const entry = {
      origin: target.origin,
      method,
      path: target.pathname,
      query: Object.fromEntries(target.searchParams),
      headers: options.headers,
      body: options.body === undefined ? undefined : JSON.parse(options.body),
    };
    fake.requests.push(entry);
    await fake.onRequest?.(entry);
    const index = fake.failures.findIndex(
      (f) => target.pathname.startsWith(f.path) && (!f.method || f.method === method),
    );
    if (index !== -1) {
      const [failure] = fake.failures.splice(index, 1);
      if (failure.error) {
        if (failure.sent) options.onSent?.();
        const err = new NextDnsError(failure.error, 'fake failure');
        if (!failure.sent) err.notSent = true;
        throw err;
      }
      options.onSent?.();
      return {
        status: failure.status,
        headers: failure.headers ?? { 'content-type': 'application/json' },
        body: Buffer.from(
          failure.body ?? JSON.stringify({ errors: [{ code: failure.code ?? 'error' }] }),
        ),
      };
    }
    options.onSent?.();
    if (options.headers?.['x-api-key'] !== API_KEY) {
      return json(403, { errors: [{ code: 'forbidden' }] });
    }
    const parts = target.pathname.split('/').filter(Boolean);
    if (method === 'GET' && target.pathname === '/profiles')
      return json(200, { data: fake.profiles });
    const id = parts[1];
    const settings = fake.settings[id];
    if (parts[0] !== 'profiles' || !settings) return json(404, { errors: [{ code: 'notFound' }] });
    if (method === 'GET' && parts.length === 2) return json(200, { data: settings });
    if (method === 'GET' && parts[2] === 'analytics') {
      const list = fake[parts[3]]?.[id];
      if (!list) return json(404, { errors: [{ code: 'notFound' }] });
      return json(200, { data: list, meta: { pagination: { cursor: null } } });
    }
    if (method === 'PATCH' || method === 'POST') {
      fake.commands.push(entry);
      if (fake.commandGate) await fake.commandGate;
      const body = entry.body;
      if (method === 'PATCH' && ['security', 'privacy'].includes(parts[2]) && parts.length === 3) {
        Object.assign(settings[parts[2]], body);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      }
      if (method === 'PATCH' && parts[2] === 'parentalControl' && parts.length === 3) {
        Object.assign(settings.parentalControl, body);
        return { status: 204, headers: {}, body: Buffer.alloc(0) };
      }
      if (parts[2] === 'parentalControl' && ['services', 'categories'].includes(parts[3])) {
        const list = settings.parentalControl[parts[3]];
        if (method === 'POST' && parts.length === 4) {
          list.push({ id: body.id, active: body.active !== false });
          return json(200, { data: { id: body.id, active: true } });
        }
        if (method === 'PATCH' && parts.length === 5) {
          const item = list.find((i) => i.id === decodeURIComponent(parts[4]));
          if (!item) return json(404, { errors: [{ code: 'notFound' }] });
          item.active = body.active;
          return { status: 204, headers: {}, body: Buffer.alloc(0) };
        }
      }
    }
    return json(404, { errors: [{ code: 'notFound' }] });
  };
  return fake;
}

export { CODES };
