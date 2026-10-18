// -----------------------------------------------------------------------------
// Gladys devices (pure).
//
//   profile  `ext:<selector>:profile:<NextDNS profile id>`
//            one per NextDNS profile: queries and blocked queries (24 h),
//            blocked and encrypted shares, devices seen, the state of each
//            filter (read only), and one command select for the filters.
//
// The profile id is the one NextDNS gives the profile (stable; its name may
// change). Never a `switch`: the core hands every switch to the voice
// assistants, MCP and the "turn off" scene actions, so "turn everything off"
// would remove the protections. A filter is a read-only `unknown`/`binary`;
// commands go through a `text`/`select` (see src/app.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { COMMAND_NONE, FEATURES, LIMITS, PROFILE_ID_PATTERN, PROFILE_TYPE } from './constants.js';
import { filtersOf, serviceIdOf } from './filters.js';

export const profileIds = (gladys, profileId) => gladys.externalIds(PROFILE_TYPE, profileId);

const readOnly = (extra) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

const counter = (ids, key, name, max) => ({
  name,
  external_id: ids.feature(key),
  ...readOnly({ category: C.COUNTER_SENSOR, type: T.SENSOR.INTEGER, min: 0, max }),
});

// No core category lists a percent for a share of queries: no unit (TODO.md,
// "Decisions"), `unknown`/`unknown`, the pair the front translates.
const share = (ids, key, name) => ({
  name,
  external_id: ids.feature(key),
  ...readOnly({ category: C.UNKNOWN, type: T.UNKNOWN.UNKNOWN, min: 0, max: 100 }),
});

/** The options of the command select: none, then enable / disable per filter. */
export function commandOptions(filters) {
  const options = [{ value: COMMAND_NONE, label: '—' }];
  for (const filter of filters) {
    options.push(
      { value: `enable:${filter.key}`, label: `Turn on: ${filter.label}` },
      { value: `disable:${filter.key}`, label: `Turn off: ${filter.label}` },
    );
  }
  return options;
}

/** The services a device already carries (its features are never dropped). */
export function servicesOfDevice(device) {
  const services = [];
  for (const feature of device?.features ?? []) {
    const key = String(feature?.external_id ?? '')
      .split(':')
      .at(-1);
    const id = serviceIdOf(key);
    if (id) services.push(id);
  }
  return services;
}

/**
 * The services of a profile device: those already created first, then the
 * ones listed in the profile now, LIMITS.SERVICES at most.
 */
export function servicesFor(created, listed) {
  return [...new Set([...created, ...listed])].slice(0, LIMITS.SERVICES);
}

/**
 * @param {object} gladys
 * @param {{ id: string, name: string }} profile
 * @param {string[]} services the services of the device (servicesFor)
 */
export function buildProfileDevice(gladys, profile, services = []) {
  const ids = profileIds(gladys, profile.id);
  const filters = filtersOf(services);
  return {
    name: `NextDNS: ${profile.name}`,
    external_id: ids.device,
    model: 'NextDNS profile',
    should_poll: false,
    features: [
      counter(ids, FEATURES.QUERIES, 'Queries (24 h)', 1_000_000_000),
      counter(ids, FEATURES.BLOCKED, 'Blocked queries (24 h)', 1_000_000_000),
      share(ids, FEATURES.BLOCKED_RATIO, 'Blocked queries (%)'),
      share(ids, FEATURES.ENCRYPTED_RATIO, 'Encrypted queries (%)'),
      counter(ids, FEATURES.DEVICES, 'Devices seen (24 h)', LIMITS.DEVICES_PAGE),
      {
        name: 'Filter command',
        external_id: ids.feature(FEATURES.COMMAND),
        category: C.TEXT,
        type: T.TEXT.SELECT,
        min: 0,
        max: 0,
        read_only: false,
        has_feedback: false,
        keep_history: false,
        supported_options: commandOptions(filters),
      },
      ...filters.map((filter) => ({
        name: filter.label,
        external_id: ids.feature(filter.key),
        // Read only, never a switch (see above). 1 on, 0 off.
        ...readOnly({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 }),
      })),
    ],
  };
}

/**
 * What a device or feature external id of this integration designates:
 * { profileId, feature } (feature null for the device) | null.
 */
export function parseExternalId(gladys, externalId) {
  if (typeof externalId !== 'string') return null;
  const prefix = gladys.externalId(`${PROFILE_TYPE}:`);
  if (!externalId.startsWith(prefix)) return null;
  const [profileId, feature, ...rest] = externalId.slice(prefix.length).split(':');
  if (rest.length > 0 || !PROFILE_ID_PATTERN.test(profileId ?? '')) return null;
  return { profileId, feature: feature ?? null };
}

/** The created profile devices: [{ profileId, externalId, device }]. */
export function createdProfiles(gladys, devices = gladys.devices) {
  const list = [];
  for (const device of devices ?? []) {
    const parsed = parseExternalId(gladys, device?.external_id);
    if (!parsed || parsed.feature !== null) continue;
    list.push({ profileId: parsed.profileId, externalId: device.external_id, device });
  }
  return list;
}
