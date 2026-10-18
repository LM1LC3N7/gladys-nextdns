// -----------------------------------------------------------------------------
// Keys, limits and timings. The manifest keys and the external id shapes are
// stored in user devices and scenes: never rename them (test/manifest.test.js
// ties them to the manifest).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({
  TEST: 'test_connection',
});

/** The only host the API key is ever sent to. */
export const API_ORIGIN = 'https://api.nextdns.io';

/** Device external ids: `ext:<selector>:profile:<NextDNS profile id>`. */
export const PROFILE_TYPE = 'profile';

/** A NextDNS profile id (`abc123`): letters and digits only. */
export const PROFILE_ID_PATTERN = /^[A-Za-z0-9]{1,32}$/;

/** The fixed features of a profile device (filters: see src/filters.js). */
export const FEATURES = Object.freeze({
  QUERIES: 'queries',
  BLOCKED: 'blocked',
  BLOCKED_RATIO: 'blocked_ratio',
  ENCRYPTED_RATIO: 'encrypted_ratio',
  DEVICES: 'devices',
  COMMAND: 'command',
});

/** The value of the command select at rest (no command). */
export const COMMAND_NONE = 'none';

/** Seconds between two readings; the first one is the default. */
export const REFRESH_INTERVALS = Object.freeze(['300', '600', '900', '1800', '3600']);

/** Caps: what is published, read and remembered. */
export const LIMITS = Object.freeze({
  PROFILES: 10,
  /** Parental control services kept as filters per profile. */
  SERVICES: 60,
  /** One page of /analytics/devices (the API maximum). */
  DEVICES_PAGE: 500,
  /**
   * POST /state admits 300 states per minute per integration: this
   * integration keeps under 250 (a profile waits for the next round beyond).
   */
  STATES_PER_MINUTE: 250,
});

export const TIMEOUTS = Object.freeze({
  API: 10_000,
});

/**
 * Gladys waits 5 s for the acknowledgement of a command: past this budget,
 * counted from the moment the command arrives, nothing is sent to NextDNS
 * (an action must never run after Gladys showed a failure).
 */
export const COMMAND_BUDGET_MS = 3_500;
/** Room kept after the fresh read for the command request itself. */
export const COMMAND_MIN_SEND_MS = 1_000;
/** Room needed to start the fresh read at all. */
export const COMMAND_MIN_READ_MS = 1_500;
/** Once sent, Gladys gets its answer at the latest this long after the command arrived. */
export const COMMAND_ACK_MS = 4_300;

export const INTERVALS = Object.freeze({
  /** Failures retry at the reading interval at least, doubling up to this. */
  RETRY_MAX_MS: 3600_000,
  /** HTTP 429: pause of every request, within these bounds (Retry-After if given). */
  BUSY_MIN_MS: 60_000,
  BUSY_MAX_MS: 6 * 3600_000,
  /** After a command: the profile is read again once. */
  AFTER_COMMAND_MS: 3_000,
});

/** Size cap of an answer of the API. */
export const MAX_BYTES = 1024 * 1024;

/** The persistent store (refusal, pause: see src/store.js). */
export const STORE_FILE = 'nextdns.json';
