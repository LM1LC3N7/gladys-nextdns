// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys and the fake NextDNS, through
// the exact wiring of the container (src/handlers.js).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { NextDnsApp, SELECT_RESET_MS } from '../src/app.js';
import { ACTIONS, API_ORIGIN, COMMAND_ACK_MS, INTERVALS, STORE_FILE } from '../src/constants.js';
import { buildProfileDevice } from '../src/devices.js';
import { registerHandlers } from '../src/handlers.js';
import { CODES } from '../src/nextdns/errors.js';
import { API_KEY, createFakeNextdns } from './helpers/fakeNextdns.js';
import { createFakeTimers } from './helpers/fakeTimers.js';

const T0 = Date.parse('2026-10-18T08:00:00Z');
const SELECTOR = 'nextdns';
const ids = createFakeGladys({ selector: SELECTOR });
const HOME = { id: 'abc123', name: 'Home' };
const KIDS = { id: 'def456', name: 'Kids' };
const homeDevice = buildProfileDevice(ids, HOME, ['fortnite', 'tiktok']);
const kidsDevice = buildProfileDevice(ids, KIDS, ['fortnite', 'tiktok']);
const featureId = (device, key) => `${device.external_id}:${key}`;
const feature = (device, key) =>
  device.features.find((f) => f.external_id === featureId(device, key));
const BASE_CONFIG = { api_key: API_KEY };
const INTERVAL = 300_000;

let running;
afterEach(async () => {
  await running?.stop();
  running = undefined;
});

async function setup({ config = {}, devices = [homeDevice, kidsDevice], nextdns, dataDir } = {}) {
  const clock = { now: T0 };
  nextdns ??= createFakeNextdns();
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: { ...BASE_CONFIG, ...config },
    devices,
  });
  const timers = createFakeTimers();
  const logs = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(`${level} ${args.map((a) => a?.stack ?? String(a)).join(' ')}`),
    ]),
  );
  dataDir ??= mkdtempSync(join(tmpdir(), 'nextdns-app-'));
  const app = new NextDnsApp({
    gladys,
    logger,
    request: nextdns.request,
    dataDir,
    now: () => clock.now,
    timers,
  });
  running = app;
  registerHandlers(gladys, app, logger);
  await gladys.connect();
  return { gladys, nextdns, timers, clock, logs, app, dataDir };
}

const state = (gladys, device, key) => gladys.fake.lastState(featureId(device, key));
const command = (gladys, device, value) =>
  gladys.fake.setValue(device, feature(device, 'command'), value);
const writes = (nextdns) => nextdns.requests.filter((r) => r.method !== 'GET');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 20; i += 1) await tick();
};

test('start: Discovery gets every profile; figures, filters, badges', async () => {
  const { gladys, nextdns, timers } = await setup();
  assert.deepEqual(gladys.fake.connectionStatus, {
    connected: true,
    message: { en: 'NextDNS answers: 2 profiles read.', fr: 'NextDNS répond : 2 profils lus.' },
  });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => [d.external_id, d.name]),
    [
      [`ext:${SELECTOR}:profile:abc123`, 'NextDNS: Home'],
      [`ext:${SELECTOR}:profile:def456`, 'NextDNS: Kids'],
    ],
  );
  assert.equal(state(gladys, homeDevice, 'queries'), 1000);
  assert.equal(state(gladys, homeDevice, 'blocked'), 100);
  assert.equal(state(gladys, homeDevice, 'blocked_ratio'), 10);
  assert.equal(state(gladys, homeDevice, 'encrypted_ratio'), 75);
  assert.equal(state(gladys, homeDevice, 'devices'), 2, 'unidentified devices left out');
  assert.equal(state(gladys, kidsDevice, 'blocked_ratio'), 0, 'no query: 0');
  assert.equal(state(gladys, homeDevice, 'filter-security-csam'), 1);
  assert.equal(state(gladys, homeDevice, 'filter-security-google-safe-browsing'), 0);
  assert.equal(state(gladys, homeDevice, 'filter-category-porn'), 1);
  assert.equal(state(gladys, homeDevice, 'filter-category-gambling'), 0, 'absent: not blocked');
  assert.equal(state(gladys, homeDevice, 'filter-service-tiktok'), 1);
  assert.equal(state(gladys, homeDevice, 'filter-service-fortnite'), 0);
  assert.equal(state(gladys, homeDevice, 'filter-parental-block-bypass'), 1);
  assert.equal(state(gladys, homeDevice, 'filter-privacy-disguised-trackers'), 1);
  assert.equal(
    state(gladys, homeDevice, 'filter-security-data-drop-services'),
    undefined,
    'a toggle the profile does not carry is unknown: nothing published',
  );
  assert.equal(state(gladys, homeDevice, 'command'), 'none');
  assert.ok(gladys.fake.transports.every((t) => t.transport === 'cloud'));
  assert.deepEqual(timers.delays(), [INTERVAL]);
  assert.equal(nextdns.requests.length, 1 + 4 * 2);
  for (const r of nextdns.requests) {
    assert.equal(r.origin, API_ORIGIN, 'the key only goes to api.nextdns.io');
    assert.equal(r.headers['x-api-key'], API_KEY);
    assert.ok(!JSON.stringify(r.query).includes(API_KEY), 'never in a URL');
    if (r.path.includes('/analytics/')) assert.equal(r.query.from, '-1d');
  }
});

test('the loop reads at the interval; a reading never touches the filters', async () => {
  const { gladys, nextdns, timers } = await setup();
  nextdns.status.abc123[1].queries = 300;
  await timers.run();
  assert.equal(state(gladys, homeDevice, 'blocked'), 300);
  assert.equal(writes(nextdns).length, 0, 'reading only');
  assert.deepEqual(timers.delays(), [INTERVAL]);
});

test('the refresh interval of the configuration', async () => {
  const { timers } = await setup({ config: { refresh_interval: '1800' } });
  assert.deepEqual(timers.delays(), [1_800_000]);
});

test('the profile filter, and an id absent from the account', async () => {
  const { gladys, nextdns } = await setup({ config: { profiles: 'def456, zzz999' } });
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.name),
    ['NextDNS: Kids'],
  );
  assert.ok(!nextdns.requests.some((r) => r.path.startsWith('/profiles/abc123')));
  assert.match(gladys.fake.connectionStatus.message.en, /Not found in the account: zzz999/);
});

test('an invalid profile id or key is said, nothing sent', async () => {
  const one = await setup({ config: { profiles: 'abc123, ../x' } });
  assert.match(one.gladys.fake.connectionStatus.message.en, /not NextDNS profile ids.*\.\.\/x/);
  assert.equal(one.nextdns.requests.length, 0);
  await one.app.stop();
  const two = await setup({ config: { api_key: 'abc​def' } });
  assert.match(two.gladys.fake.connectionStatus.message.en, /invisible character/);
  assert.equal(two.nextdns.requests.length, 0);
});

test('a refused key is final, remembered in /data without the key, retried by the user only', async () => {
  const wrong = 'wrong-key-0123456789';
  const first = await setup({ config: { api_key: wrong } });
  assert.match(first.gladys.fake.connectionStatus.message.en, /refused the API key/);
  assert.deepEqual(first.timers.delays(), [], 'no retry');
  const file = readFileSync(join(first.dataDir, STORE_FILE), 'utf8');
  assert.ok(!file.includes(wrong), 'the key is never written to /data');
  await first.app.stop();

  const second = await setup({ config: { api_key: wrong }, dataDir: first.dataDir });
  assert.equal(second.nextdns.requests.length, 0, 'a restart does not send it again');
  assert.match(second.gladys.fake.connectionStatus.message.en, /refused the API key/);
  second.gladys.emit('connected');
  await tick();
  assert.equal(second.nextdns.requests.length, 0, 'nor a reconnection to Gladys');
  await second.gladys.fake.configUpdated({ ...BASE_CONFIG });
  assert.equal(second.gladys.fake.connectionStatus.connected, true, 'a saved configuration tries');
  const logs = [...first.logs, ...second.logs].join('\n');
  assert.ok(!logs.includes(wrong) && !logs.includes(API_KEY), 'never in the logs');
});

test('a 403 page of a proxy (not the API) is a passing failure, retried at the interval', async () => {
  const nextdns = createFakeNextdns();
  nextdns.failures.push({
    path: '/profiles',
    status: 403,
    headers: { 'content-type': 'text/html' },
    body: '<html>Forbidden</html>',
  });
  const { gladys, timers } = await setup({ nextdns });
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.en, /does not answer: HTTP error 403/);
  assert.deepEqual(timers.delays(), [INTERVAL], 'never faster than the interval');
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('HTTP 429: a pause kept in /data, capped when read back; the user lifts it', async () => {
  const nextdns = createFakeNextdns();
  nextdns.failures.push({ path: '/profiles', status: 429, headers: { 'retry-after': '7200' } });
  const first = await setup({ nextdns });
  assert.match(first.gladys.fake.connectionStatus.message.en, /slow down \(HTTP 429\)/);
  assert.deepEqual(first.timers.delays(), [7_200_000]);
  first.gladys.emit('connected');
  await tick();
  assert.equal(first.nextdns.requests.length, 1, 'a reconnection to Gladys keeps the pause');
  await first.app.stop();

  const second = await setup({ dataDir: first.dataDir });
  assert.equal(second.nextdns.requests.length, 0, 'a restart waits too');
  assert.deepEqual(second.timers.delays(), [7_200_000]);
  await second.app.stop();

  // A pause end far in the future (clock, file) is capped at 6 h.
  const store = JSON.parse(readFileSync(join(first.dataDir, STORE_FILE), 'utf8'));
  store.meta.pausedUntil = String(T0 + 100 * 24 * 3600_000);
  writeFileSync(join(first.dataDir, STORE_FILE), JSON.stringify(store));
  const third = await setup({ dataDir: first.dataDir });
  assert.deepEqual(third.timers.delays(), [INTERVALS.BUSY_MAX_MS]);
  const ack = await third.gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true, ack.error);
  assert.match(ack.data.message.en, /Connected: 2 profiles/);
});

test('HTTP 5xx on the profiles: a pause kept in /data, growing, never under the interval', async () => {
  const nextdns = createFakeNextdns();
  nextdns.failures.push({ path: '/profiles', method: 'GET', status: 503 });
  nextdns.failures.push({ path: '/profiles', method: 'GET', status: 503 });
  const { gladys, timers, dataDir, clock } = await setup({ nextdns });
  assert.match(gladys.fake.connectionStatus.message.en, /server error \(HTTP 503\)/);
  assert.deepEqual(timers.delays(), [INTERVAL]);
  const store = JSON.parse(readFileSync(join(dataDir, STORE_FILE), 'utf8'));
  assert.equal(Number(store.meta.pausedUntil), T0 + INTERVAL);
  clock.now += INTERVAL;
  await timers.run();
  assert.deepEqual(timers.delays(), [2 * INTERVAL], 'doubled');
  clock.now += 2 * INTERVAL;
  await timers.run();
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('a secondary request that fails never blocks the other figures', async () => {
  const nextdns = createFakeNextdns();
  nextdns.failures.push({ path: '/profiles/abc123/analytics/encryption', status: 500 });
  const { gladys } = await setup({ nextdns });
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(gladys.fake.connectionStatus.message.en, /1 profile was not read completely/);
  assert.equal(state(gladys, homeDevice, 'queries'), 1000);
  assert.equal(state(gladys, homeDevice, 'devices'), 2);
  assert.equal(state(gladys, homeDevice, 'encrypted_ratio'), undefined);
});

test('HTTP 429 on any request pauses every path', async () => {
  const nextdns = createFakeNextdns();
  nextdns.failures.push({ path: '/profiles/abc123/analytics/devices', status: 429 });
  const { gladys, timers } = await setup({ nextdns });
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.deepEqual(timers.delays(), [INTERVAL], '1 min asked, the interval at least');
  assert.ok(
    !nextdns.requests.some((r) => r.path.startsWith('/profiles/def456')),
    'stopped at once',
  );
  const ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.equal(ack.success, false);
});

test('a reconnection to Gladys re-sends what it mirrors, without a request', async () => {
  const { gladys, nextdns } = await setup();
  const before = nextdns.requests.length;
  const statuses = gladys.fake.connectionStatuses.length;
  gladys.emit('connected');
  await tick();
  await tick();
  assert.equal(nextdns.requests.length, before);
  assert.ok(gladys.fake.connectionStatuses.length > statuses, 'the status is sent again');
});

// --- Commands ------------------------------------------------------------------

test('the filters are readings, never switches; commands are off by default', async () => {
  for (const f of homeDevice.features) {
    assert.notEqual(f.category, 'switch', f.name);
    if (f.external_id.includes(':filter-')) {
      assert.equal(f.read_only, true);
      assert.equal(f.category, 'unknown');
      assert.equal(f.type, 'binary');
    }
  }
  const select = feature(homeDevice, 'command');
  assert.deepEqual([select.category, select.type, select.read_only], ['text', 'select', false]);
  const { gladys, nextdns } = await setup();
  const before = nextdns.requests.length;
  let ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Commands are off/);
  ack = await gladys.fake.setValue(homeDevice, feature(homeDevice, 'filter-security-nrd'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /is a reading/);
  assert.equal(nextdns.requests.length, before, 'nothing sent');
});

test('turning a filter on: fresh reading, then the request; already on, nothing sent', async () => {
  const { gladys, nextdns, timers } = await setup({ config: { allow_commands: true } });
  let ack = await command(gladys, homeDevice, 'enable:filter-security-google-safe-browsing');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    writes(nextdns).map((r) => [r.method, r.path, r.body]),
    [['PATCH', '/profiles/abc123/security', { googleSafeBrowsing: true }]],
  );
  assert.equal(state(gladys, homeDevice, 'filter-security-google-safe-browsing'), 1);
  ack = await command(gladys, homeDevice, 'enable:filter-security-csam');
  assert.equal(ack.success, true, ack.error);
  assert.equal(writes(nextdns).length, 1, 'already on: nothing sent');
  ack = await command(gladys, homeDevice, 'enable:filter-category-gambling');
  assert.equal(ack.success, true, ack.error);
  ack = await command(gladys, homeDevice, 'enable:filter-service-fortnite');
  assert.equal(ack.success, true, ack.error);
  ack = await command(gladys, homeDevice, 'enable:filter-parental-safe-search');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    writes(nextdns)
      .slice(1)
      .map((r) => [r.method, r.path, r.body]),
    [
      ['POST', '/profiles/abc123/parentalControl/categories', { id: 'gambling', active: true }],
      ['PATCH', '/profiles/abc123/parentalControl/services/fortnite', { active: true }],
      ['PATCH', '/profiles/abc123/parentalControl', { safeSearch: true }],
    ],
  );
  // The select goes back to "none", and the profile is read again once.
  await timers.run((ms) => ms < INTERVAL);
  assert.equal(state(gladys, homeDevice, 'command'), 'none');
  assert.equal(state(gladys, homeDevice, 'filter-category-gambling'), 1);
});

test('turning a protection off needs the second option too', async () => {
  const one = await setup({ config: { allow_commands: true } });
  const before = one.nextdns.requests.length;
  let ack = await command(one.gladys, homeDevice, 'disable:filter-security-csam');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Turning a protection off is refused/);
  ack = await command(one.gladys, homeDevice, 'disable:filter-category-porn');
  assert.equal(ack.success, false);
  assert.equal(one.nextdns.requests.length, before, 'nothing read nor sent');
  await one.app.stop();

  const two = await setup({ config: { allow_disable_protection: true } });
  ack = await command(two.gladys, homeDevice, 'disable:filter-security-csam');
  assert.match(ack.error, /Commands are off/, 'the second option alone allows nothing');

  await two.gladys.fake.configUpdated({
    ...BASE_CONFIG,
    allow_commands: true,
    allow_disable_protection: true,
  });
  ack = await command(two.gladys, homeDevice, 'disable:filter-security-csam');
  assert.equal(ack.success, true, ack.error);
  ack = await command(two.gladys, homeDevice, 'disable:filter-service-tiktok');
  assert.equal(ack.success, true, ack.error);
  ack = await command(two.gladys, homeDevice, 'disable:filter-category-gambling');
  assert.equal(ack.success, true, 'absent: already off, nothing sent');
  assert.deepEqual(
    writes(two.nextdns).map((r) => [r.method, r.path, r.body]),
    [
      ['PATCH', '/profiles/abc123/security', { csam: false }],
      ['PATCH', '/profiles/abc123/parentalControl/services/tiktok', { active: false }],
    ],
  );
  assert.equal(state(two.gladys, homeDevice, 'filter-security-csam'), 0);
});

test('a command decides on the fresh reading, never on memory; unknown is refused', async () => {
  const { gladys, nextdns } = await setup({ config: { allow_commands: true } });
  // NextDNS changed meanwhile (the app of NextDNS): on now, memory says off.
  nextdns.settings.abc123.security.nrd = true;
  let ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.equal(ack.success, true, ack.error);
  assert.equal(writes(nextdns).length, 0, 'already on in the fresh reading');
  assert.equal(state(gladys, homeDevice, 'filter-security-nrd'), 1);
  ack = await command(gladys, homeDevice, 'enable:filter-security-data-drop-services');
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not be read: nothing was sent/);
  nextdns.failures.push({ path: '/profiles/abc123', method: 'GET', status: 500 });
  ack = await command(gladys, homeDevice, 'enable:filter-security-ddns');
  assert.equal(ack.success, false);
  assert.match(ack.error, /HTTP error 500.*nothing was sent/);
  assert.equal(writes(nextdns).length, 0);
});

test('values of the select are checked strictly', async () => {
  const { gladys, nextdns } = await setup({ config: { allow_commands: true } });
  const before = nextdns.requests.length;
  for (const value of [
    '',
    1,
    null,
    'enable:',
    'enable:filter-security-unknown',
    'on:filter-security-nrd',
    'enable:filter-service-../x',
  ]) {
    const ack = await command(gladys, homeDevice, value);
    assert.equal(ack.success, false, String(value));
  }
  const none = await command(gladys, homeDevice, 'none');
  assert.equal(none.success, true);
  assert.equal(nextdns.requests.length, before);
});

test('nothing is sent past 3.5 s after the command arrived', async () => {
  const { gladys, nextdns, clock } = await setup({ config: { allow_commands: true } });
  nextdns.onRequest = (r) => {
    if (r.method === 'GET' && r.path === '/profiles/abc123') clock.now += 3_000;
  };
  const ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.equal(ack.success, false);
  assert.match(ack.error, /could not be checked in time .*: nothing was sent/);
  assert.equal(writes(nextdns).length, 0);
});

test('a command met by HTTP 429 pauses everything; not sent and unconfirmed are told apart', async () => {
  const { gladys, nextdns, timers } = await setup({ config: { allow_commands: true } });
  nextdns.failures.push({
    path: '/profiles/abc123/security',
    method: 'PATCH',
    error: CODES.UNREACHABLE,
  });
  let ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.match(ack.error, /could not reach NextDNS .*nothing was sent/);
  nextdns.failures.push({
    path: '/profiles/abc123/security',
    method: 'PATCH',
    error: CODES.TIMEOUT,
    sent: true,
  });
  ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.match(ack.error, /was sent but NextDNS did not confirm it/);
  assert.doesNotMatch(ack.error, /nothing was sent/);
  nextdns.failures.push({
    path: '/profiles/abc123/security',
    method: 'PATCH',
    status: 400,
    code: 'invalid',
  });
  ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.match(ack.error, /NextDNS refused the command \(HTTP error 400\)/);
  nextdns.failures.push({ path: '/profiles/abc123/security', method: 'PATCH', status: 429 });
  ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.match(ack.error, /HTTP 429/);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.match(ack.error, /slow down: nothing was sent/);
  assert.ok(timers.delays().includes(INTERVAL));
});

test('a slow answer: Gladys is answered at 4.3 s, the state follows', async () => {
  const { gladys, nextdns, timers } = await setup({ config: { allow_commands: true } });
  let open;
  nextdns.commandGate = new Promise((resolve) => {
    open = resolve;
  });
  const pending = command(gladys, homeDevice, 'enable:filter-security-nrd');
  for (let i = 0; i < 20 && !timers.delays().includes(COMMAND_ACK_MS); i += 1) await tick();
  await timers.run((ms) => ms === COMMAND_ACK_MS);
  const ack = await pending;
  assert.equal(ack.success, false, 'told, not hidden');
  assert.match(ack.error, /was sent, NextDNS has not confirmed it yet/);
  assert.doesNotMatch(ack.error, /nothing was sent/);
  assert.equal(state(gladys, homeDevice, 'filter-security-nrd'), 0, 'not confirmed yet');
  // The chain of the profile waits for the request still unanswered.
  const reads = () => nextdns.requests.filter((r) => r.path === '/profiles/abc123').length;
  const before = reads();
  const next = command(gladys, homeDevice, 'enable:filter-security-ddns');
  await settle();
  assert.equal(reads(), before, 'the next command waits');
  open();
  await settle();
  assert.equal(state(gladys, homeDevice, 'filter-security-nrd'), 1, 'the state follows');
  const second = await next;
  assert.equal(second.success, true, second.error);
  assert.equal(reads(), before + 1);
});

test('unticking an option applies at once, even behind a slow reading (B1)', async () => {
  const both = { ...BASE_CONFIG, allow_commands: true, allow_disable_protection: true };
  const { app, nextdns } = await setup({ config: both });
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  nextdns.onRequest = async (r) => {
    if (r.path === '/profiles') await gate;
  };
  const first = app.start(both, { force: true });
  await settle();
  const second = app.start({ ...BASE_CONFIG, allow_commands: true }, { force: true });
  const before = nextdns.requests.length;
  await assert.rejects(
    app.setValue(homeDevice, feature(homeDevice, 'command'), 'disable:filter-security-csam'),
    /Turning a protection off is refused/,
  );
  assert.equal(nextdns.requests.length, before, 'nothing read nor sent');
  // A command accepted just before is refused before sending (new generation).
  nextdns.onRequest = null;
  open();
  await Promise.all([first, second]);
  assert.equal(writes(nextdns).length, 0);
  assert.equal(app.config.allowDisable, false);
});

test('a second connected during the first reading: the reading goes on at once', async () => {
  const { app, gladys, nextdns, timers } = await setup();
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  let gated = false;
  nextdns.onRequest = async (r) => {
    if (!gated && r.path === '/profiles') {
      gated = true;
      await gate;
    }
  };
  // A start (first reading held), then Gladys reconnects with the same configuration.
  const first = app.start({ ...BASE_CONFIG }, { force: true });
  await settle();
  assert.equal(app.online, false);
  gladys.emit('connected');
  await settle();
  open();
  await first;
  await settle();
  assert.equal(app.online, true, 'the first reading was not cut short');
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.deepEqual(timers.delays(), [INTERVAL], 'the loop, not a retry in 5 minutes');
});

test('resume() reads at once when nothing has succeeded yet', async () => {
  const { app, nextdns } = await setup();
  app.online = false;
  app.retryDelay = 0;
  const before = nextdns.requests.length;
  await app.resume();
  assert.equal(app.online, true);
  assert.ok(nextdns.requests.length > before);
});

test('a command accepted before a new configuration is refused before sending', async () => {
  const both = { ...BASE_CONFIG, allow_commands: true, allow_disable_protection: true };
  const { app, gladys, nextdns } = await setup({ config: both });
  nextdns.onRequest = async (r) => {
    if (r.method === 'GET' && r.path === '/profiles/abc123' && nextdns.onRequest) {
      nextdns.onRequest = null;
      app.start({ ...BASE_CONFIG, allow_commands: true }, { force: true });
    }
  };
  const ack = await command(gladys, homeDevice, 'disable:filter-security-csam');
  assert.equal(ack.success, false);
  assert.equal(writes(nextdns).length, 0);
});

test('the select goes back to "none" after the ack, despite a pause; a failure is retried', async () => {
  const { gladys, nextdns, timers } = await setup({ config: { allow_commands: true } });
  const nones = () =>
    gladys.fake.states.filter(
      (s) => s.device_feature_external_id === featureId(homeDevice, 'command') && s.text === 'none',
    ).length;
  const start = nones();
  let ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.equal(ack.success, true, ack.error);
  assert.equal(nones(), start, 'not before the ack');
  await timers.run((ms) => ms === SELECT_RESET_MS);
  assert.equal(nones(), start + 1, 'sent again although already "none" for the SDK');

  // A 429 halts the loop: the reset still happens.
  nextdns.failures.push({ path: '/profiles/abc123/security', method: 'PATCH', status: 429 });
  ack = await command(gladys, homeDevice, 'enable:filter-security-ddns');
  assert.match(ack.error, /HTTP 429/);
  await timers.run((ms) => ms === SELECT_RESET_MS);
  assert.equal(nones(), start + 2);
});

test('a reset of the select that fails is published by the next round', async () => {
  const { gladys, timers, clock } = await setup({ config: { allow_commands: true } });
  const ack = await command(gladys, homeDevice, 'enable:filter-security-nrd');
  assert.equal(ack.success, true, ack.error);
  const publish = gladys.publishChangedStates.bind(gladys);
  gladys.publishChangedStates = async () => {
    throw new Error('Gladys away');
  };
  await timers.run((ms) => ms === SELECT_RESET_MS);
  gladys.publishChangedStates = publish;
  const nones = () =>
    gladys.fake.states.filter(
      (s) => s.device_feature_external_id === featureId(homeDevice, 'command') && s.text === 'none',
    ).length;
  const before = nones();
  clock.now += INTERVAL;
  await timers.run((ms) => ms === INTERVAL);
  assert.equal(nones(), before + 1);
});

test('only the options of the device: a forged service, an unknown profile, refused', async () => {
  const { gladys, nextdns } = await setup({ config: { allow_commands: true } });
  const before = nextdns.requests.length;
  let ack = await command(gladys, homeDevice, 'enable:filter-service-zoom');
  assert.equal(ack.success, false);
  assert.match(ack.error, /Invalid value/);
  const stranger = buildProfileDevice(ids, { id: 'zzz999', name: 'Other' }, []);
  ack = await command(gladys, stranger, 'enable:filter-security-nrd');
  assert.match(ack.error, /not followed/);
  assert.equal(nextdns.requests.length, before);
});

test('an item without a boolean "active" is shown on but refused for a command', async () => {
  const nextdns = createFakeNextdns();
  nextdns.settings.abc123.parentalControl.services = [{ id: 'tiktok' }, { id: 'fortnite' }];
  const { gladys } = await setup({
    nextdns,
    config: { allow_commands: true, allow_disable_protection: true },
  });
  assert.equal(state(gladys, homeDevice, 'filter-service-tiktok'), 1);
  const ack = await command(gladys, homeDevice, 'disable:filter-service-tiktok');
  assert.match(ack.error, /could not be read: nothing was sent/);
  assert.equal(writes(nextdns).length, 0);
});

test('HTTP 429 met while a reading runs: the reading stops, the status stays "paused" (I4)', async () => {
  const { gladys, nextdns, timers, clock } = await setup({ config: { allow_commands: true } });
  nextdns.failures.push({ path: '/profiles/abc123/security', method: 'PATCH', status: 429 });
  let fired = false;
  nextdns.onRequest = async (r) => {
    if (!fired && r.path === '/profiles/abc123/analytics/status') {
      fired = true;
      await command(gladys, homeDevice, 'enable:filter-security-nrd');
    }
  };
  const before = nextdns.requests.length;
  clock.now += INTERVAL;
  await timers.run((ms) => ms === INTERVAL);
  assert.ok(fired);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  const after = nextdns.requests.slice(before).map((r) => r.path);
  assert.ok(!after.includes('/profiles/def456'), `no request after the pause: ${after}`);
  assert.deepEqual(
    timers.delays().filter((ms) => ms !== SELECT_RESET_MS),
    [INTERVAL],
  );
});

test('a reconnection during a pause re-sends the status and the Discovery (I5)', async () => {
  const nextdns = createFakeNextdns();
  const { gladys, timers, clock } = await setup({ nextdns });
  let discoveries = 0;
  const publish = gladys.publishDiscoveredDevices.bind(gladys);
  gladys.publishDiscoveredDevices = (devices) => {
    discoveries += 1;
    return publish(devices);
  };
  nextdns.failures.push({ path: '/profiles', method: 'GET', status: 429 });
  clock.now += INTERVAL;
  await timers.run((ms) => ms === INTERVAL);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  const statuses = gladys.fake.connectionStatuses.length;
  const requests = nextdns.requests.length;
  gladys.emit('connected');
  await settle();
  assert.equal(gladys.fake.connectionStatuses.length, statuses + 1);
  assert.match(gladys.fake.connectionStatus.message.en, /slow down/);
  assert.equal(discoveries, 1, 'the profiles known are published again');
  assert.equal(nextdns.requests.length, requests, 'no request during the pause');
  assert.deepEqual(timers.delays(), [INTERVAL], 'the end of the pause still scheduled');
});

test('10 profiles at most: the created ones first, the others said left out (M4)', async () => {
  const nextdns = createFakeNextdns();
  for (let i = 0; i < 11; i += 1) {
    nextdns.profiles.push({ id: `zz${String(i).padStart(4, '0')}`, name: `P${i}` });
  }
  const last = buildProfileDevice(ids, { id: 'zz0010', name: 'P10' }, []);
  const { gladys } = await setup({ nextdns, devices: [last] });
  const names = gladys.fake.discoveredDevices.map((d) => d.name);
  assert.equal(names.length, 10);
  assert.ok(names.includes('NextDNS: P10'), 'the created profile is kept');
  assert.match(gladys.fake.connectionStatus.message.en, /3 profiles left out/);
});

test('a device updated in Gladys gets its states again (M6)', async () => {
  const { gladys } = await setup();
  const count = () =>
    gladys.fake.states.filter(
      (s) => s.device_feature_external_id === featureId(homeDevice, 'queries'),
    ).length;
  const before = count();
  await gladys.fake.deviceUpdated(homeDevice);
  await settle();
  assert.equal(count(), before + 1);
});

test('a created device gets its states; its services are never dropped', async () => {
  const { gladys, nextdns, timers } = await setup({ devices: [] });
  assert.equal(gladys.fake.states.length, 0, 'nothing for devices not created');
  const discovered = gladys.fake.discoveredDevices.find((d) => d.name === 'NextDNS: Home');
  await gladys.fake.deviceCreated(discovered);
  assert.equal(state(gladys, discovered, 'queries'), 1000);
  assert.equal(state(gladys, discovered, 'filter-service-tiktok'), 1);
  assert.ok(gladys.fake.transports.some((t) => t.transport === 'cloud'));
  // TikTok removed from the profile in NextDNS: the feature stays, off.
  nextdns.settings.abc123.parentalControl.services = [];
  await timers.run();
  const again = gladys.fake.discoveredDevices.find((d) => d.name === 'NextDNS: Home');
  assert.ok(again.features.some((f) => f.external_id.endsWith(':filter-service-tiktok')));
  assert.equal(state(gladys, discovered, 'filter-service-tiktok'), 0);
});

test('Test the connection answers within the button time', async () => {
  const { gladys } = await setup();
  const ack = await gladys.fake.action(ACTIONS.TEST);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(ack.data.message, { en: 'Connected: 2 profiles.', fr: 'Connecté : 2 profils.' });
});
