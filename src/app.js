// -----------------------------------------------------------------------------
// NextDnsApp: the integration. One NextDNS account (API key), its profiles.
//
//   start(config)  (re)connects: profiles read, Discovery published, loop started
//   reading loop   every `refresh_interval` (5 min by default): the list of
//                  the profiles, then per profile its settings (filters) and
//                  three analytics of the last 24 h (status, encryption,
//                  devices), one request at a time
//   setValue       the "Filter command" select, see "Commands" below
//
// The loop is one chain of timers: halt() bumps an epoch, and a run of an
// older epoch never schedules itself again. An API key NextDNS refused is
// final: the loop stops and the status says what to fix; nothing is sent
// again until the configuration is saved or "Test the connection" is pressed.
// A failure is never read again faster than the interval; HTTP 429 and 5xx
// pauses are kept in /data (a restart waits too).
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { createLogger } from '@gladysassistant/integration-sdk';
import { Budget } from './budget.js';
import { normalizeConfig } from './config.js';
import {
  COMMAND_ACK_MS,
  COMMAND_BUDGET_MS,
  COMMAND_MIN_READ_MS,
  COMMAND_MIN_SEND_MS,
  COMMAND_NONE,
  FEATURES,
  INTERVALS,
  LIMITS,
  STORE_FILE,
  TIMEOUTS,
} from './constants.js';
import {
  buildProfileDevice,
  commandOptions,
  createdProfiles,
  parseExternalId,
  profileIds,
  servicesFor,
  servicesOfDevice,
} from './devices.js';
import { filterByKey, filtersOf, readProfile, requestFor } from './filters.js';
import { T } from './i18n.js';
import { Store } from './store.js';
import { NextDnsClient } from './nextdns/client.js';
import { CODES, isBusy, isKeyRefused, isServerError } from './nextdns/errors.js';
import { httpRequest } from './nextdns/http.js';

/** The "Test the connection" button waits 30 s: answer before. */
const TEST_BUDGET_MS = 25_000;
/** After a command, the select goes back to "none" once Gladys stored the choice. */
export const SELECT_RESET_MS = 1_500;
const COMMAND_PATTERN = /^(enable|disable):(filter-[a-z0-9-]{1,80})$/;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class NextDnsApp {
  /**
   * @param {object} options
   * @param {import('@gladysassistant/integration-sdk').GladysIntegration} options.gladys
   * @param {object} [options.logger]
   * @param {Function} [options.request] the HTTP transport (tests inject a fake NextDNS)
   * @param {string} [options.dataDir] the writable volume
   * @param {() => number} [options.now]
   * @param {{ setTimeout: Function, clearTimeout: Function }} [options.timers]
   */
  constructor({
    gladys,
    logger = createLogger({ name: 'nextdns' }),
    request = httpRequest,
    dataDir = process.env.DATA_DIR ?? '/data',
    now = Date.now,
    timers = globalThis,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.request = request;
    this.now = now;
    this.timers = timers;
    this.store = new Store({ filePath: join(dataDir, STORE_FILE), logger });
    this.budget = new Budget({ perMinute: LIMITS.STATES_PER_MINUTE, now });
    this.rawConfig = null;
    this.config = normalizeConfig();
    this.client = null;
    this.generation = 0;
    this.epoch = 0;
    /** The timers of the loop (cleared by halt()). */
    this.handles = new Set();
    /** The timers of the select resets: a pause (halt) never cancels them. */
    this.resetHandles = new Set();
    this.queue = Promise.resolve();
    /** One chain of commands per profile. */
    this.chains = new Map();
    /** profile id -> a command request still unanswered (the chain waits for it). */
    this.unsettled = new Map();
    /** The status the integration wants Gladys to show: [connected, message]. */
    this.wantedStatus = null;
    this.lastStatus = null;
    this.reset();
  }

  reset() {
    this.online = false;
    this.blocked = false;
    this.pausedUntil = 0;
    this.retryDelay = 0;
    /** id -> { id, name } of the profiles followed. */
    this.profiles = new Map();
    /**
     * id -> { status, encryption, devices, filters: Map<key, 0|1>, services,
     * complete } of the last reading (a part that failed is null).
     */
    this.readings = new Map();
    /** Ids of the configuration absent from the account. */
    this.missing = [];
    /** Profiles not read completely by the last round. */
    this.failedProfiles = 0;
    /** Profiles left out by the cap of LIMITS.PROFILES. */
    this.leftOut = 0;
    /** Bumped by every command on a profile: a reading crossed by one keeps the command's result. */
    this.filterVersions = new Map();
    this.clearCaches();
  }

  /** What only mirrors Gladys (lost when the core restarts): emptied on every `connected`. */
  clearCaches() {
    this.lastStatus = null;
    this.discoveredKey = null;
    this.transports = new Map();
    /** feature external id -> value last accepted by Gladys (to budget only changes). */
    this.published = new Map();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** Run `task` after every start / restart already queued. */
  enqueue(task) {
    const run = this.queue.then(task);
    this.queue = run.catch(() => {});
    return run;
  }

  /**
   * A new configuration arrives: until its start runs (it waits behind the
   * starts and readings queued), the permissions are those that BOTH the old
   * and the new configuration grant, and the commands already accepted are
   * refused before sending (new generation).
   */
  tighten(rawConfig) {
    const next = normalizeConfig(rawConfig);
    const narrowed = {
      ...this.config,
      allowCommands: this.config.allowCommands && next.allowCommands,
      allowDisable: this.config.allowDisable && next.allowDisable,
    };
    // Only a real narrowing invalidates what is in flight: an unchanged
    // configuration (a reconnection) never aborts a reading.
    const lessAllowed =
      narrowed.allowCommands !== this.config.allowCommands ||
      narrowed.allowDisable !== this.config.allowDisable;
    this.config = narrowed;
    if (lessAllowed) this.generation += 1;
  }

  /**
   * (Re)start with a configuration. Calls are serialized. `force`: the user
   * asked (button, saved configuration): a key refused earlier is tried, a
   * pause is lifted.
   */
  start(rawConfig, { force = false } = {}) {
    this.tighten(rawConfig);
    return this.enqueue(() => this.run(rawConfig, { force }));
  }

  /**
   * Gladys is back (the `connected` event): the same configuration keeps the
   * client, the pause and the refusal; only what mirrors Gladys is sent again.
   */
  reconnected(rawConfig) {
    this.tighten(rawConfig);
    return this.enqueue(async () => {
      const same =
        this.rawConfig !== null &&
        JSON.stringify(rawConfig ?? {}) === JSON.stringify(this.rawConfig);
      if (!same) {
        await this.run(rawConfig, { force: false });
        return;
      }
      this.config = normalizeConfig(rawConfig);
      this.clearCaches();
      if (this.wantedStatus) await this.setStatus(...this.wantedStatus);
      if (this.profiles.size > 0) await this.publishDiscovered();
      if (this.online) await this.publishAllStates();
      await this.publishTransports();
      await this.resume();
    });
  }

  /** The timers of the previous generation stopped (tighten): start them again, as they were. */
  async resume() {
    this.halt();
    const generation = this.generation;
    if (this.blocked || !this.client) return;
    if (this.paused()) {
      this.schedule(this.pausedUntil - this.now(), () => this.connect(generation));
    } else if (this.online) {
      this.scheduleLoop(generation);
    } else if (this.retryDelay === 0) {
      // Nothing has succeeded yet (a first reading cut short): read at once.
      await this.connect(generation);
    } else {
      this.schedule(Math.max(this.config.intervalMs, this.retryDelay), () =>
        this.connect(generation),
      );
    }
  }

  /** The value a refusal is about (HMAC with the salt of /data: never the key). */
  async refusalKey(config) {
    return createHmac('sha256', await this.store.salt())
      .update(config.apiKey)
      .digest('hex');
  }

  async stop() {
    this.generation += 1;
    this.halt();
    for (const handle of this.resetHandles) this.timers.clearTimeout(handle);
    this.resetHandles.clear();
    this.dropClient();
  }

  /** Clear every timer of the loop; the runs still in flight will not schedule again. */
  halt() {
    this.epoch += 1;
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
  }

  dropClient() {
    this.client?.close();
    this.client = null;
  }

  async run(rawConfig, { force = false } = {}) {
    this.halt();
    this.dropClient();
    const generation = ++this.generation;
    this.rawConfig = rawConfig ?? {};
    const config = normalizeConfig(rawConfig);
    this.config = config;
    this.reset();
    await this.store.load();

    if (!config.apiKey) {
      await this.setStatus(false, T.status.missingKey);
      return;
    }
    if (config.apiKeyInvalid) {
      await this.setStatus(false, T.status.keyInvalid);
      return;
    }
    if (config.filter?.invalid.length > 0) {
      await this.setStatus(false, T.status.profilesInvalid(config.filter.invalid));
      return;
    }
    // A key NextDNS refused is not tried again alone.
    const refused = this.store.get('refusals', 'key');
    if (refused && refused === (await this.refusalKey(config)) && !force) {
      this.blocked = true;
      this.logger.warn('API key refused earlier: not tried again');
      await this.setStatus(false, T.status.keyRefused);
      return;
    }
    if (refused) await this.store.set('refusals', 'key', null);
    this.client = new NextDnsClient({
      apiKey: config.apiKey,
      request: this.request,
      now: this.now,
    });
    // A pause asked by NextDNS outlives a restart and a reconnection to
    // Gladys; only the user lifts it (button, saved configuration). The end
    // read back is capped (a clock or a file gone wrong never blocks for long).
    const stored = Number(this.store.get('meta', 'pausedUntil')) || 0;
    const pausedUntil = Math.min(stored, this.now() + INTERVALS.BUSY_MAX_MS);
    if (force && stored) await this.store.set('meta', 'pausedUntil', null);
    if (!force && this.now() < pausedUntil) {
      this.pausedUntil = pausedUntil;
      const delay = pausedUntil - this.now();
      await this.setStatus(false, T.status.busy(delay));
      this.schedule(delay, () => this.connect(generation));
      return;
    }
    await this.connect(generation);
  }

  schedule(delay, task, handles = this.handles) {
    const handle = this.timers.setTimeout(async () => {
      handles.delete(handle);
      try {
        await task();
      } catch (err) {
        this.logger.error('Loop failed', err);
      }
    }, delay);
    handles.add(handle);
    return handle;
  }

  /** May a loop of this generation and epoch schedule its next run? */
  current(generation, epoch) {
    return generation === this.generation && epoch === this.epoch && !this.blocked;
  }

  /** First reading, then the loop. Never throws. */
  async connect(generation) {
    if (!this.client || generation !== this.generation) return;
    if (this.paused()) {
      // A timer may fire a little early, or a longer pause came meanwhile.
      this.schedule(Math.max(1_000, this.pausedUntil - this.now()), () => this.connect(generation));
      return;
    }
    const epoch = this.epoch;
    let applied;
    try {
      applied = await this.readAll({ publish: true });
    } catch (err) {
      await this.failed(err, generation);
      return;
    }
    // Not applied: a pause, a new configuration or a halt came meanwhile,
    // and whoever did it scheduled what follows.
    if (!applied || !this.current(generation, epoch)) return;
    this.logger.info(`NextDNS answers: ${this.profiles.size} profile(s)`);
    this.scheduleLoop(generation);
  }

  scheduleLoop(generation) {
    const epoch = this.epoch;
    this.schedule(this.config.intervalMs, () => this.loop(generation, epoch));
  }

  async loop(generation, epoch) {
    if (!this.current(generation, epoch)) return;
    try {
      await this.readAll({ publish: false });
    } catch (err) {
      if (this.current(generation, epoch)) await this.failed(err, generation);
      return;
    }
    if (this.current(generation, epoch)) this.scheduleLoop(generation);
  }

  /** A reading failed: final refusal, or retry (never faster than the interval). */
  async failed(err, generation) {
    const interval = this.config.intervalMs;
    let delay;
    if (isBusy(err)) {
      // Too many requests: a bounded pause of every path (loop, commands).
      delay = Math.max(
        interval,
        clamp(
          err.retryAfterMs ?? INTERVALS.BUSY_MIN_MS,
          INTERVALS.BUSY_MIN_MS,
          INTERVALS.BUSY_MAX_MS,
        ),
      );
    } else {
      delay = Math.max(interval, this.retryDelay);
      if (isServerError(err) && err.retryAfterMs) {
        delay = clamp(err.retryAfterMs, delay, INTERVALS.BUSY_MAX_MS);
      }
    }
    // A pause holds whatever the generation (a new configuration does not
    // make NextDNS less busy); kept in /data.
    if (isBusy(err) || isServerError(err)) {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + delay);
      await this.store.set('meta', 'pausedUntil', String(this.pausedUntil));
    }
    if (generation !== this.generation) return;
    const wasOnline = this.online;
    this.online = false;
    this.halt();
    await this.publishTransports();
    if (isKeyRefused(err)) {
      this.blocked = true;
      await this.store.set('refusals', 'key', await this.refusalKey(this.config));
      this.logger.warn(
        `API key refused by NextDNS (HTTP ${err.status}): not retried until changed`,
      );
      await this.setStatus(false, T.status.keyRefused);
      return;
    }
    if (!isBusy(err)) {
      this.retryDelay = Math.min(delay * 2, Math.max(interval, INTERVALS.RETRY_MAX_MS));
    }
    if (wasOnline || delay === interval) {
      this.logger.warn(`NextDNS fails: ${err.message}`);
    }
    await this.setStatus(false, this.errorMessage(err, delay));
    this.schedule(delay, () => this.connect(generation));
  }

  errorMessage(err, delay) {
    if (isBusy(err)) return T.status.busy(delay);
    if (isServerError(err)) return T.status.serverError(err.status, delay);
    return T.status.unreachable(err, delay);
  }

  /**
   * An HTTP 429 met by a command or a secondary request: NextDNS refused it
   * without doing it. Every path pauses (failed()), and the caller is told so.
   */
  async throwIfBusy(err, generation) {
    if (!isBusy(err)) return;
    await this.failed(err, generation);
    throw new Error(T.errors.busyRefused, { cause: err });
  }

  paused() {
    return this.now() < this.pausedUntil;
  }

  /**
   * The status wanted is kept apart from the mark of what Gladys received:
   * a reconnection sends the wanted one again.
   */
  async setStatus(connected, message) {
    this.wantedStatus = [connected, message];
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys.setConnectionStatus(connected, message).catch((err) => {
      this.lastStatus = null;
      this.logger.warn(`Connection status not sent: ${err.message}`);
    });
  }

  // --- Reading ---------------------------------------------------------------

  /**
   * Read the profiles, then each followed profile, one request at a time.
   * Throws when the list of the profiles fails, or on HTTP 429 anywhere (a
   * pause of every path). Any other failure of a profile request only leaves
   * that part unread this round (the other figures still go). Resolves false,
   * applying nothing, when a pause, a new configuration or a halt came
   * meanwhile.
   */
  async readAll({ publish }) {
    const client = this.client;
    const generation = this.generation;
    const epoch = this.epoch;
    const stale = () =>
      this.paused() ||
      client !== this.client ||
      generation !== this.generation ||
      epoch !== this.epoch;
    if (!client || stale()) return false;
    const all = await client.profiles();
    const filter = this.config.filter;
    const candidates = filter ? all.filter((p) => filter.ids.has(p.id)) : all;
    // The cap keeps the profiles already created first.
    const created = new Set(createdProfiles(this.gladys).map((c) => c.profileId));
    const ordered = [
      ...candidates.filter((p) => created.has(p.id)),
      ...candidates.filter((p) => !created.has(p.id)),
    ];
    const followed = ordered.slice(0, LIMITS.PROFILES);
    const missing = filter ? [...filter.ids].filter((id) => !all.some((p) => p.id === id)) : [];
    const readings = new Map();
    let failed = 0;
    for (const profile of followed) {
      const reading = await this.readProfileOnce(client, profile.id, stale);
      if (!reading) return false;
      if (!reading.complete) failed += 1;
      readings.set(profile.id, reading);
    }
    if (stale()) return false;

    this.profiles = new Map(followed.map((p) => [p.id, p]));
    for (const [id, reading] of readings) this.readings.set(id, reading);
    for (const id of [...this.readings.keys()]) {
      if (!this.profiles.has(id)) this.readings.delete(id);
    }
    this.missing = missing;
    this.failedProfiles = failed;
    this.leftOut = ordered.length - followed.length;
    this.online = true;
    this.retryDelay = 0;

    const discoveredKey = JSON.stringify(
      [...this.profiles.values()].map((p) => [p.id, p.name, this.servicesOf(p.id)]),
    );
    if (publish || discoveredKey !== this.discoveredKey) await this.publishDiscovered();
    this.discoveredKey = discoveredKey;
    await this.publishAllStates();
    await this.publishTransports();
    await this.setStatus(true, this.okMessage());
    return true;
  }

  /**
   * One profile: settings, then the analytics. Throws only on HTTP 429;
   * resolves null when `stale()` turns true before a request.
   */
  async readProfileOnce(client, id, stale = () => false) {
    const previous = this.readings.get(id);
    const reading = {
      status: null,
      encryption: null,
      devices: null,
      filters: previous?.filters ?? null,
      services: previous?.services ?? [],
      complete: true,
    };
    let gone = false;
    const attempt = async (label, task) => {
      if (gone || stale()) {
        gone = true;
        return null;
      }
      try {
        return await task();
      } catch (err) {
        if (isBusy(err)) throw err;
        reading.complete = false;
        this.logger.debug(`Profile ${id}: ${label} not read (${err.message})`);
        return null;
      }
    };
    const version = this.filterVersions.get(id) ?? 0;
    const settings = await attempt('settings', () => client.profile(id));
    if (settings && version === (this.filterVersions.get(id) ?? 0)) {
      this.applySettings(reading, id, settings);
    }
    reading.status = await attempt('status', () => client.status(id));
    reading.encryption = await attempt('encryption', () => client.encryption(id));
    reading.devices = await attempt('devices', () => client.devices(id));
    return gone ? null : reading;
  }

  /** The filter states of a fresh profile answer, for every filter of the device. */
  applySettings(reading, id, settings) {
    const read = readProfile(settings);
    reading.services = read.services;
    const filters = new Map();
    for (const filter of filtersOf(servicesFor(this.createdServices(id), read.services))) {
      const state = read.state(filter);
      if (state !== null) filters.set(filter.key, state);
    }
    reading.filters = filters;
  }

  /** The services the created device of a profile already carries. */
  createdServices(id) {
    const created = createdProfiles(this.gladys).find((c) => c.profileId === id);
    return created ? servicesOfDevice(created.device) : [];
  }

  /** The services of the device of a profile: created ones kept, new ones added. */
  servicesOf(id) {
    return servicesFor(this.createdServices(id), this.readings.get(id)?.services ?? []);
  }

  okMessage() {
    if (this.profiles.size === 0) return T.status.noProfile;
    return T.status.ok({
      profiles: this.profiles.size,
      failed: this.failedProfiles,
      missing: this.missing,
      leftOut: this.leftOut,
    });
  }

  /** Never throws: a refusal of Gladys is not a NextDNS failure. */
  async publishDiscovered() {
    const devices = [...this.profiles.values()].map((profile) =>
      buildProfileDevice(this.gladys, profile, this.servicesOf(profile.id)),
    );
    await this.gladys.publishDiscoveredDevices(devices).catch((err) => {
      this.logger.warn(`Discovery not published: ${err.message}`);
    });
  }

  /** Discovery (scan button): what the last reading knows (no extra request). */
  async publishDiscovery() {
    if (this.profiles.size > 0) await this.publishDiscovered();
  }

  /** The states of a created profile device, from the last reading. */
  statesOf(created) {
    const id = created.profileId;
    const reading = this.readings.get(id);
    if (!reading || !this.profiles.has(id)) return [];
    const ids = profileIds(this.gladys, id);
    const states = [];
    const push = (key, state) =>
      states.push({ device_feature_external_id: ids.feature(key), state });
    if (reading.status) {
      push(FEATURES.QUERIES, reading.status.total);
      push(FEATURES.BLOCKED, reading.status.blocked);
      push(FEATURES.BLOCKED_RATIO, reading.status.blockedRatio);
    }
    if (reading.encryption) push(FEATURES.ENCRYPTED_RATIO, reading.encryption.encryptedRatio);
    if (reading.devices) push(FEATURES.DEVICES, reading.devices.count);
    if (reading.filters) {
      for (const filter of filtersOf(servicesOfDevice(created.device))) {
        const state = reading.filters.get(filter.key);
        if (state === 0 || state === 1) push(filter.key, state);
      }
    }
    states.push({ device_feature_external_id: ids.feature(FEATURES.COMMAND), text: COMMAND_NONE });
    return states;
  }

  /** Publish the states that changed, profile by profile, within the minute budget. */
  async publishAllStates() {
    for (const created of createdProfiles(this.gladys)) {
      await this.publishStates(this.statesOf(created));
    }
  }

  async publishStates(states) {
    const valueOf = (s) => (s.text === undefined ? s.state : s.text);
    const list = states.filter(
      (s) => this.published.get(s.device_feature_external_id) !== valueOf(s),
    );
    if (list.length === 0) return;
    if (list.length > this.budget.remaining()) {
      this.logger.debug(`${list.length} state(s) held back to the next round (state budget)`);
      return;
    }
    try {
      const result = await this.gladys.publishChangedStates(list);
      this.budget.record(result?.count ?? list.length);
      for (const s of list) this.published.set(s.device_feature_external_id, valueOf(s));
    } catch (err) {
      this.logger.warn(`States not published: ${err.message}`);
    }
  }

  async publishTransports() {
    const entries = createdProfiles(this.gladys).map(({ profileId, externalId }) => ({
      external_id: externalId,
      transport:
        this.online && this.profiles.has(profileId) && this.readings.has(profileId)
          ? 'cloud'
          : 'unreachable',
    }));
    const changed = entries.filter((e) => this.transports.get(e.external_id) !== e.transport);
    if (changed.length === 0) return;
    for (const entry of changed) this.transports.set(entry.external_id, entry.transport);
    await this.gladys.publishTransports(changed).catch((err) => {
      for (const entry of changed) this.transports.delete(entry.external_id);
      this.logger.debug(`Transports not published: ${err.message}`);
    });
  }

  // --- Commands --------------------------------------------------------------
  //
  // One `text`/`select` per profile, "Filter command": "Turn on: <filter>"
  // or "Turn off: <filter>" (never a switch: the core hands every switch to
  // the voice assistants, MCP and the "turn off" scene actions). Turning a
  // filter on needs `allow_commands`; turning one off (a security protection,
  // a parental control, a privacy blocking) needs `allow_disable_protection`
  // too. Both are off by default, checked when the command arrives AND just
  // before it is sent; a new configuration narrows them at once, before its
  // start runs (tighten()). Only the options of the device are accepted.
  // Commands are chained per profile (a request still unanswered holds the
  // chain until it settles or times out) and keep the client of the moment
  // they arrived. Each one reads the profile from NextDNS just before acting
  // and decides on that fresh reading only: unknown state, refused; already
  // in the state asked, nothing is sent. Gladys waits 5 s: past 3.5 s after
  // the command arrived, nothing is sent any more. A command that may have
  // left is never said "not sent".

  async setValue(_device, feature, value) {
    const received = this.now();
    const parsed = parseExternalId(this.gladys, feature?.external_id);
    if (!parsed?.feature) throw new Error(T.errors.unknownDevice);
    if (parsed.feature !== FEATURES.COMMAND) {
      const known =
        Object.values(FEATURES).includes(parsed.feature) || filterByKey(parsed.feature) !== null;
      throw new Error(known ? T.errors.readOnly : T.errors.unknownDevice);
    }
    if (value === COMMAND_NONE) return;
    try {
      await this.commandValue(received, parsed.profileId, value);
    } finally {
      // Armed once the answer is decided: Gladys stores the choice on its ack.
      this.resetSelectSoon(parsed.profileId);
    }
  }

  async commandValue(received, profileId, value) {
    const match = typeof value === 'string' ? COMMAND_PATTERN.exec(value) : null;
    if (!match) throw new Error(T.errors.invalidValue);
    const enable = match[1] === 'enable';
    // The permissions first: they hold whatever the state of the profiles.
    if (!this.config.allowCommands) throw new Error(T.errors.commandsDisabled);
    if (!enable && !this.config.allowDisable) throw new Error(T.errors.disableRefused);
    if (!this.profiles.has(profileId)) throw new Error(T.errors.unknownProfile);
    // Only an option of this device's select: never a forged service id.
    const allowed = commandOptions(filtersOf(this.servicesOf(profileId))).map((o) => o.value);
    const filter = allowed.includes(value) ? filterByKey(match[2]) : null;
    if (!filter) throw new Error(T.errors.invalidValue);
    const client = this.client;
    if (!client || this.blocked) throw new Error(T.errors.notConnected);
    if (this.paused()) throw new Error(T.errors.busy);
    const generation = this.generation;

    const previous = this.chains.get(profileId) ?? Promise.resolve();
    const run = previous.then(() =>
      this.command(received, { client, generation, profileId, filter, enable }),
    );
    // The next command waits for this one, and for its request if still unanswered.
    const chain = run
      .catch(() => {})
      .then(() => this.unsettled.get(profileId))
      .catch(() => {});
    this.chains.set(profileId, chain);
    chain.then(() => {
      if (this.chains.get(profileId) === chain) this.chains.delete(profileId);
    });
    return run;
  }

  /** The client, the configuration and the permissions are still those of the command. */
  stillValid({ client, generation, enable }) {
    if (client !== this.client || generation !== this.generation || this.blocked) {
      throw new Error(T.errors.configChanged);
    }
    if (!this.config.allowCommands) throw new Error(T.errors.commandsDisabled);
    if (!enable && !this.config.allowDisable) throw new Error(T.errors.disableRefused);
    if (this.paused()) throw new Error(T.errors.busy);
  }

  async command(received, { client, generation, profileId, filter, enable }) {
    this.bumpFilters(profileId);
    try {
      this.stillValid({ client, generation, enable });
      const deadline = received + COMMAND_BUDGET_MS;
      if (deadline - this.now() < COMMAND_MIN_READ_MS) throw new Error(T.errors.tooSlow);
      let fresh;
      try {
        fresh = await client.profile(profileId, { deadline: deadline - COMMAND_MIN_SEND_MS });
      } catch (err) {
        await this.throwIfBusy(err, generation);
        throw new Error(T.errors.unknownState(err), { cause: err });
      }
      // Decided on the fresh reading only, never on what is in memory.
      const read = readProfile(fresh);
      const current = read.commandState(filter);
      if (current !== 0 && current !== 1) throw new Error(T.errors.unknownState(null));
      const wanted = enable ? 1 : 0;
      if (current === wanted) {
        this.observedLater(generation, profileId, filter, current);
        return;
      }
      const request = requestFor(profileId, filter, enable, { present: read.present(filter) });
      if (!request) throw new Error(T.errors.unknownState(null));
      if (deadline - this.now() < COMMAND_MIN_SEND_MS) throw new Error(T.errors.tooSlow);
      // The last check before acting: the user may have changed things meanwhile.
      this.stillValid({ client, generation, enable });
      await this.send({
        client,
        generation,
        profileId,
        filter,
        wanted,
        request,
        received,
        deadline,
      });
    } finally {
      this.bumpFilters(profileId);
    }
  }

  bumpFilters(profileId) {
    this.filterVersions.set(profileId, (this.filterVersions.get(profileId) ?? 0) + 1);
  }

  /** Send, then answer Gladys on NextDNS's answer or at COMMAND_ACK_MS, whichever first. */
  async send({ client, generation, profileId, filter, wanted, request, received, deadline }) {
    let sent = false;
    const pending = client.command(request, {
      deadline,
      onSent: () => {
        sent = true;
      },
    });
    // The chain of the profile waits for this request to settle, or for its timeout.
    let expiry;
    const settled = new Promise((resolve) => {
      expiry = this.timers.setTimeout(resolve, TIMEOUTS.API + 1_000);
      pending.then(resolve, resolve);
    }).finally(() => {
      this.timers.clearTimeout(expiry);
      if (this.unsettled.get(profileId) === settled) this.unsettled.delete(profileId);
    });
    this.unsettled.set(profileId, settled);
    let handle;
    const ack = new Promise((resolve) => {
      handle = this.timers.setTimeout(resolve, Math.max(0, received + COMMAND_ACK_MS - this.now()));
    });
    const outcome = await Promise.race([
      pending.then(
        () => ({ done: true }),
        (err) => ({ err }),
      ),
      ack.then(() => ({ waiting: true })),
    ]);
    this.timers.clearTimeout(handle);
    if (outcome.done) {
      this.observedLater(generation, profileId, filter, wanted);
      this.refreshSoon(generation, profileId);
      return;
    }
    if (outcome.waiting) {
      // Sent, no answer yet: Gladys is told so now, the reading follows.
      this.logger.info(`${filter.key} of profile ${profileId} sent, no confirmation yet`);
      pending
        .then(
          () => this.observedLater(generation, profileId, filter, wanted),
          (err) => this.logger.warn(`${filter.key} of profile ${profileId} failed: ${err.message}`),
        )
        .finally(() => this.refreshSoon(generation, profileId));
      throw new Error(T.errors.pendingConfirmation);
    }
    const { err } = outcome;
    await this.throwIfBusy(err, generation);
    if (err.notSent || !sent) throw new Error(T.errors.notSent(err), { cause: err });
    this.refreshSoon(generation, profileId);
    // The API answered with a refusal: nothing was done.
    if ((err.code === CODES.HTTP && err.status < 500) || err.code === CODES.API) {
      throw new Error(T.errors.refused(err), { cause: err });
    }
    throw new Error(T.errors.unconfirmed(err), { cause: err });
  }

  /** What a command just read or did, published without holding the answer to Gladys. */
  observedLater(generation, profileId, filter, state) {
    if (generation !== this.generation) return;
    this.observed(profileId, filter, state).catch((err) =>
      this.logger.debug(`State not published: ${err.message}`),
    );
  }

  /** What a command just read or did, until the next reading. */
  async observed(profileId, filter, state) {
    const reading = this.readings.get(profileId);
    if (!reading) return;
    reading.filters ??= new Map();
    reading.filters.set(filter.key, state);
    const created = createdProfiles(this.gladys).find((c) => c.profileId === profileId);
    if (created) await this.publishStates(this.statesOf(created));
  }

  /**
   * Put the select back on "none" once Gladys stored the choice of the user.
   * Its own timers: a pause (halt) does not cancel it. Failed: the next
   * round of the loop publishes it again.
   */
  resetSelectSoon(profileId) {
    const featureId = profileIds(this.gladys, profileId).feature(FEATURES.COMMAND);
    this.published.delete(featureId);
    this.schedule(
      SELECT_RESET_MS,
      async () => {
        this.gladys.forgetPublishedStates(featureId);
        try {
          await this.gladys.publishChangedStates([
            { device_feature_external_id: featureId, text: COMMAND_NONE },
          ]);
          this.published.set(featureId, COMMAND_NONE);
        } catch (err) {
          this.published.delete(featureId);
          this.logger.debug(`Select not reset: ${err.message}`);
        }
      },
      this.resetHandles,
    );
  }

  /** Read the filters of a profile again in a moment (after a command). */
  refreshSoon(generation, profileId) {
    if (generation !== this.generation) return;
    this.schedule(INTERVALS.AFTER_COMMAND_MS, async () => {
      const client = this.client;
      if (generation !== this.generation || !client || !this.online || this.paused()) return;
      const reading = this.readings.get(profileId);
      if (!reading) return;
      const version = this.filterVersions.get(profileId) ?? 0;
      try {
        const settings = await client.profile(profileId);
        if (
          version !== (this.filterVersions.get(profileId) ?? 0) ||
          client !== this.client ||
          this.paused()
        ) {
          return;
        }
        this.applySettings(reading, profileId, settings);
        const created = createdProfiles(this.gladys).find((c) => c.profileId === profileId);
        if (created) await this.publishStates(this.statesOf(created));
      } catch (err) {
        // A 429 pauses every path; anything else waits for the loop.
        if (isBusy(err)) await this.failed(err, generation);
        else this.logger.debug(`Reading after a command failed: ${err.message}`);
      }
    });
  }

  // --- Devices created / updated / deleted in Gladys -------------------------

  async deviceCreated(device) {
    const parsed = parseExternalId(this.gladys, device?.external_id);
    if (!parsed) return;
    // The SDK forgot the values of this device: so does the budget cache.
    for (const key of [...this.published.keys()]) {
      if (key.startsWith(`${device.external_id}:`)) this.published.delete(key);
    }
    this.transports.delete(device.external_id);
    if (!this.online) {
      await this.publishTransports();
      return;
    }
    // The services of a profile are those of its created device from now on.
    const reading = this.readings.get(parsed.profileId);
    if (reading?.filters) {
      reading.services = servicesFor(servicesOfDevice(device), reading.services);
    }
    await this.publishAllStates();
    await this.publishTransports();
  }

  deviceDeleted(device) {
    this.transports.delete(device?.external_id);
  }

  // --- Configuration buttons -------------------------------------------------

  /** Resolves `promise`, or rejects with `message` after `ms`. */
  within(promise, ms, message) {
    let handle;
    const limit = new Promise((_, reject) => {
      handle = this.timers.setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, limit]).finally(() => this.timers.clearTimeout(handle));
  }

  /** Reconnects (a refused key and a pause included: the user asked), then reports, within 25 s. */
  async testConnection() {
    await this.within(
      this.start(this.rawConfig ?? (await this.gladys.getConfig()), { force: true }),
      TEST_BUDGET_MS,
      T.errors.testTooLong,
    );
    if (!this.online) {
      const message = this.wantedStatus ? this.wantedStatus[1] : null;
      throw new Error(message?.en ?? T.errors.notConnected);
    }
    return T.test.ok({ profiles: this.profiles.size });
  }
}
