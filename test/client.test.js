// -----------------------------------------------------------------------------
// The client, the answer parsers and the filters (pure parts).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { API_ORIGIN } from '../src/constants.js';
import { NextDnsClient } from '../src/nextdns/client.js';
import { CODES, isKeyRefused } from '../src/nextdns/errors.js';
import {
  parseDevices,
  parseEncryption,
  parseProfiles,
  parseStatus,
  ratio,
} from '../src/nextdns/parse.js';
import {
  FIXED_FILTERS,
  filterByKey,
  filtersOf,
  readProfile,
  requestFor,
  serviceIdOf,
} from '../src/filters.js';
import { profileSettings } from './helpers/fakeNextdns.js';

const answer =
  (status, body, headers = { 'content-type': 'application/json' }) =>
  async () => ({
    status,
    headers,
    body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  });

test('the client: the key in the header, the fixed origin, envelopes and errors', async () => {
  const seen = [];
  const client = new NextDnsClient({
    apiKey: 'k',
    request: async (url, options) => {
      seen.push([url, options.headers]);
      return {
        status: 200,
        headers: {},
        body: Buffer.from('{"data":[{"id":"abc123","name":"Home"}]}'),
      };
    },
  });
  assert.deepEqual(await client.profiles(), [{ id: 'abc123', name: 'Home' }]);
  assert.deepEqual(seen, [[`${API_ORIGIN}/profiles`, { 'x-api-key': 'k' }]]);

  const refused = await new NextDnsClient({
    apiKey: 'k',
    request: answer(403, { errors: [{ code: 'forbidden' }] }),
  })
    .profiles()
    .catch((e) => e);
  assert.ok(isKeyRefused(refused), 'a JSON 403 of the API on /profiles');
  const proxy = await new NextDnsClient({
    apiKey: 'k',
    request: answer(403, '<html></html>', { 'content-type': 'text/html' }),
  })
    .profiles()
    .catch((e) => e);
  assert.equal(isKeyRefused(proxy), false, 'a 403 page of a proxy is not a refusal');
  const unauthorized = await new NextDnsClient({ apiKey: 'k', request: answer(401, '') })
    .profiles()
    .catch((e) => e);
  assert.ok(isKeyRefused(unauthorized));
  const elsewhere = await new NextDnsClient({
    apiKey: 'k',
    request: answer(403, { errors: [{ code: 'forbidden' }] }),
  })
    .profile('abc123')
    .catch((e) => e);
  assert.equal(isKeyRefused(elsewhere), false, 'only the profiles list decides');

  const busy = await new NextDnsClient({
    apiKey: 'k',
    request: answer(429, '', { 'retry-after': '120' }),
  })
    .profiles()
    .catch((e) => e);
  assert.equal(busy.status, 429);
  assert.equal(busy.retryAfterMs, 120_000);

  const userError = await new NextDnsClient({
    apiKey: 'k',
    request: answer(200, { errors: [{ code: 'invalid' }] }),
  })
    .command({ method: 'PATCH', path: '/profiles/abc123/security', body: {} })
    .catch((e) => e);
  assert.equal(userError.code, CODES.API, 'a 200 carrying errors is an error');

  const garbage = await new NextDnsClient({ apiKey: 'k', request: answer(200, 'not json') })
    .profiles()
    .catch((e) => e);
  assert.equal(garbage.code, CODES.BAD_ANSWER);
  const ok = await new NextDnsClient({ apiKey: 'k', request: answer(204, '') }).command({
    method: 'PATCH',
    path: '/profiles/abc123/security',
    body: { csam: true },
  });
  assert.equal(ok, undefined);
});

test('a command without room before its deadline is not sent', async () => {
  let called = false;
  const client = new NextDnsClient({
    apiKey: 'k',
    now: () => 1_000,
    request: async () => {
      called = true;
    },
  });
  const err = await client
    .command({ method: 'PATCH', path: '/x', body: {} }, { deadline: 1_100 })
    .catch((e) => e);
  assert.equal(err.code, CODES.NO_TIME);
  assert.equal(err.notSent, true);
  assert.equal(called, false);
  client.close();
  const closed = await client.profiles().catch((e) => e);
  assert.equal(closed.code, CODES.CLOSED);
});

test('the parsers: totals, ratios, devices, profiles', () => {
  assert.equal(ratio(1, 3), 33.3);
  assert.equal(ratio(5, 0), 0);
  assert.deepEqual(
    parseStatus({
      data: [
        { status: 'default', queries: 70 },
        { status: 'blocked', queries: 20 },
        { status: 'allowed', queries: 5 },
        { status: 'relayed', queries: 5 },
        { status: 'blocked', queries: 'x' },
      ],
    }),
    { total: 100, blocked: 20, blockedRatio: 20 },
  );
  assert.deepEqual(
    parseEncryption({
      data: [
        { encrypted: true, queries: 2 },
        { encrypted: false, queries: 1 },
      ],
    }),
    { total: 3, encrypted: 2, encryptedRatio: 66.7 },
  );
  assert.deepEqual(
    parseDevices({
      data: [
        { id: 'a', queries: 1 },
        { id: '__UNIDENTIFIED__', queries: 3 },
        { id: 'b', queries: 0 },
      ],
      meta: { pagination: { cursor: 'next' } },
    }),
    { count: 1, more: true },
  );
  assert.equal(parseStatus({ errors: [] }), null);
  assert.equal(parseStatus([]), null);
  assert.deepEqual(
    parseProfiles({
      data: [
        { id: 'abc123', name: ' Home ' },
        { id: '../x' },
        { id: 'abc123' },
        { id: 'zz9', name: '' },
      ],
    }),
    [
      { id: 'abc123', name: 'Home' },
      { id: 'zz9', name: 'zz9' },
    ],
  );
});

test('the filters: keys are stable, states read, requests built', () => {
  // Stored in devices: these keys never change.
  assert.deepEqual(FIXED_FILTERS.map((f) => f.key).slice(0, 3), [
    'filter-security-threat-intelligence-feeds',
    'filter-security-ai-threat-detection',
    'filter-security-google-safe-browsing',
  ]);
  assert.ok(FIXED_FILTERS.some((f) => f.key === 'filter-category-social-networks'));
  assert.equal(new Set(FIXED_FILTERS.map((f) => f.key)).size, FIXED_FILTERS.length);
  assert.equal(serviceIdOf('filter-service-google-chat'), 'google-chat');
  assert.equal(serviceIdOf('filter-service-../x'), null);
  assert.equal(filterByKey('filter-security-nope'), null);
  assert.equal(filterByKey('filter-service-tiktok').label, 'Block TikTok');
  // Only the own names: never a property of Object.prototype.
  assert.equal(filterByKey('filter-service-constructor').label, 'Block constructor');
  const loose = readProfile({ parentalControl: { services: [{ id: 'zoom' }], categories: [] } });
  assert.equal(loose.state(filterByKey('filter-service-zoom')), 1, 'shown as listed');
  assert.equal(
    loose.commandState(filterByKey('filter-service-zoom')),
    null,
    'unknown for a command',
  );
  assert.equal(loose.commandState(filterByKey('filter-category-porn')), 0, 'absent: off');
  assert.deepEqual(
    filtersOf(['zoom', 'tiktok', 'zoom', 'BAD'])
      .slice(-2)
      .map((f) => f.id),
    ['tiktok', 'zoom'],
  );

  const read = readProfile(profileSettings());
  const by = (key) => filterByKey(key);
  assert.equal(read.state(by('filter-security-csam')), 1);
  assert.equal(read.state(by('filter-security-nrd')), 0);
  assert.equal(read.state(by('filter-security-tunneling-endpoints')), null);
  assert.equal(read.state(by('filter-category-porn')), 1);
  assert.equal(read.state(by('filter-category-dating')), 0);
  assert.equal(read.state(by('filter-service-fortnite')), 0);
  assert.equal(read.present(by('filter-service-fortnite')), true);
  assert.equal(read.present(by('filter-service-zoom')), false);
  assert.deepEqual(read.services, ['tiktok', 'fortnite']);
  assert.equal(readProfile({}).state(by('filter-category-porn')), null, 'no list: unknown');
  assert.equal(
    readProfile({ security: { csam: 'yes' } }).state(by('filter-security-csam')),
    null,
    'not a boolean: unknown',
  );

  assert.deepEqual(
    requestFor('abc123', by('filter-parental-youtube-restricted-mode'), true, { present: false }),
    {
      method: 'PATCH',
      path: '/profiles/abc123/parentalControl',
      body: { youtubeRestrictedMode: true },
    },
  );
  assert.deepEqual(requestFor('abc123', by('filter-service-zoom'), true, { present: false }), {
    method: 'POST',
    path: '/profiles/abc123/parentalControl/services',
    body: { id: 'zoom', active: true },
  });
  assert.equal(requestFor('abc123', by('filter-service-zoom'), false, { present: false }), null);
  assert.deepEqual(
    requestFor('abc123', by('filter-privacy-disguised-trackers'), false, { present: false }),
    {
      method: 'PATCH',
      path: '/profiles/abc123/privacy',
      body: { disguisedTrackers: false },
    },
  );
});
