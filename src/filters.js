// -----------------------------------------------------------------------------
// The filters of a NextDNS profile (pure): what they are, how their state is
// read from GET /profiles/:id, and the request that turns one on or off.
//
//   security   PATCH /profiles/:id/security          { <name>: true|false }
//   privacy    PATCH /profiles/:id/privacy           { disguisedTrackers: ... }
//   parental   PATCH /profiles/:id/parentalControl   { safeSearch: ... }
//   category   PATCH /profiles/:id/parentalControl/categories/:cat  { active }
//              POST  /profiles/:id/parentalControl/categories       { id, active: true }
//   service    the same under /parentalControl/services
//
// The names, ids and endpoints follow the nextdns Python library 5.1.0
// (Apache-2.0, THIRD_PARTY_NOTICES.md) and the official API documentation.
// A category or service absent from the profile is not blocked; adding one
// is a POST (the library POSTs after a 404 on the PATCH; here the fresh
// reading tells which one to send).
// -----------------------------------------------------------------------------

export const KINDS = Object.freeze({
  SECURITY: 'security',
  PRIVACY: 'privacy',
  PARENTAL: 'parental',
  CATEGORY: 'category',
  SERVICE: 'service',
});

/** Security toggles of the profile: [API name, label]. */
const SECURITY = [
  ['threatIntelligenceFeeds', 'Threat intelligence feeds'],
  ['aiThreatDetection', 'AI-driven threat detection'],
  ['googleSafeBrowsing', 'Google Safe Browsing'],
  ['cryptojacking', 'Cryptojacking protection'],
  ['dnsRebinding', 'DNS rebinding protection'],
  ['idnHomographs', 'IDN homograph attacks protection'],
  ['typosquatting', 'Typosquatting protection'],
  ['dga', 'Domain generation algorithms protection'],
  ['nrd', 'Block newly registered domains'],
  ['ddns', 'Block dynamic DNS hostnames'],
  ['parking', 'Block parked domains'],
  ['csam', 'Block child sexual abuse material'],
  ['dataDropServices', 'Block data drop services'],
  ['decentralizedWebGateways', 'Block decentralized web gateways'],
  ['freeHostingDomains', 'Block free hosting domains'],
  ['residentialHosting', 'Block residential hosting'],
  ['tunnelingEndpoints', 'Block tunneling endpoints'],
];

const PRIVACY = [['disguisedTrackers', 'Block disguised third-party trackers']];

const PARENTAL = [
  ['safeSearch', 'Safe search'],
  ['youtubeRestrictedMode', 'YouTube restricted mode'],
  ['blockBypass', 'Block bypass methods'],
];

const CATEGORIES = [
  ['porn', 'Block porn'],
  ['gambling', 'Block gambling'],
  ['dating', 'Block dating'],
  ['piracy', 'Block piracy'],
  ['social-networks', 'Block social networks'],
  ['gaming', 'Block online gaming'],
  ['video-streaming', 'Block video streaming'],
];

/** Readable names of the services the library knows; any other id is shown as is. */
const SERVICE_NAMES = {
  '9gag': '9GAG',
  amazon: 'Amazon',
  bereal: 'BeReal',
  blizzard: 'Blizzard',
  chatgpt: 'ChatGPT',
  dailymotion: 'Dailymotion',
  discord: 'Discord',
  disneyplus: 'Disney+',
  ebay: 'eBay',
  facebook: 'Facebook',
  fortnite: 'Fortnite',
  'google-chat': 'Google Chat',
  hbomax: 'HBO Max',
  hulu: 'Hulu',
  imgur: 'Imgur',
  instagram: 'Instagram',
  leagueoflegends: 'League of Legends',
  mastodon: 'Mastodon',
  messenger: 'Messenger',
  minecraft: 'Minecraft',
  netflix: 'Netflix',
  pinterest: 'Pinterest',
  'playstation-network': 'PlayStation Network',
  primevideo: 'Prime Video',
  reddit: 'Reddit',
  roblox: 'Roblox',
  signal: 'Signal',
  skype: 'Skype',
  snapchat: 'Snapchat',
  spotify: 'Spotify',
  steam: 'Steam',
  telegram: 'Telegram',
  tiktok: 'TikTok',
  tinder: 'Tinder',
  tumblr: 'Tumblr',
  twitch: 'Twitch',
  twitter: 'X (Twitter)',
  vimeo: 'Vimeo',
  vk: 'VK',
  whatsapp: 'WhatsApp',
  xboxlive: 'Xbox Live',
  youtube: 'YouTube',
  zoom: 'Zoom',
};

/** What a service or category id may be (it ends up in a URL and an external id). */
export const ITEM_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The feature key of a filter: `filter-<kind>-<id>`. Stored in devices: never change it. */
export const filterKey = (kind, id) =>
  `filter-${kind}-${kind === KINDS.CATEGORY || kind === KINDS.SERVICE ? id : kebab(id)}`;

const make = (kind, [id, label]) => ({ key: filterKey(kind, id), kind, id, label });

/** The filters every profile device carries, in this order. */
export const FIXED_FILTERS = Object.freeze([
  ...SECURITY.map((f) => make(KINDS.SECURITY, f)),
  ...PRIVACY.map((f) => make(KINDS.PRIVACY, f)),
  ...PARENTAL.map((f) => make(KINDS.PARENTAL, f)),
  ...CATEGORIES.map((f) => make(KINDS.CATEGORY, f)),
]);

export const serviceFilter = (id) =>
  make(KINDS.SERVICE, [id, `Block ${Object.hasOwn(SERVICE_NAMES, id) ? SERVICE_NAMES[id] : id}`]);

/** The service id of a service feature key, or null. */
export function serviceIdOf(key) {
  const prefix = `filter-${KINDS.SERVICE}-`;
  if (typeof key !== 'string' || !key.startsWith(prefix)) return null;
  const id = key.slice(prefix.length);
  return ITEM_ID_PATTERN.test(id) ? id : null;
}

/** Every filter of a profile: the fixed ones, then its services (sorted). */
export function filtersOf(serviceIds = []) {
  const services = [...new Set(serviceIds)].filter((id) => ITEM_ID_PATTERN.test(id)).sort();
  return [...FIXED_FILTERS, ...services.map(serviceFilter)];
}

/**
 * The filter a feature key names, or null. Any well-formed service id is
 * accepted here: a command checks the options of the device (src/app.js).
 */
export function filterByKey(key) {
  const fixed = FIXED_FILTERS.find((f) => f.key === key);
  if (fixed) return fixed;
  const id = serviceIdOf(key);
  return id ? serviceFilter(id) : null;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const bit = (value) => (value === true ? 1 : value === false ? 0 : null);

/**
 * An entry of a list: 1 active, 0 inactive. A missing `active` is shown as
 * active (a listed item blocks), but is unknown for a command (strict).
 */
const entryState = (active, strict) => {
  if (active === true) return 1;
  if (active === false) return 0;
  return active === undefined && !strict ? 1 : null;
};

/**
 * The items of parentalControl.categories / services: id -> raw `active`,
 * or null when the list is not readable.
 */
function readList(list) {
  if (!Array.isArray(list)) return null;
  const items = new Map();
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !ITEM_ID_PATTERN.test(entry.id)) {
      continue;
    }
    items.set(entry.id, entry.active);
  }
  return items;
}

/**
 * Read a profile answer (the `data` of GET /profiles/:id).
 * -> { services: [ids], state(filter) -> 1 | 0 | null (unknown),
 *      commandState(filter) (the same, strict), present(filter) }
 */
export function readProfile(profile) {
  const security = isObject(profile?.security) ? profile.security : null;
  const privacy = isObject(profile?.privacy) ? profile.privacy : null;
  const parental = isObject(profile?.parentalControl) ? profile.parentalControl : null;
  const categories = readList(parental?.categories);
  const services = readList(parental?.services);
  const lists = { [KINDS.CATEGORY]: categories, [KINDS.SERVICE]: services };
  const stateOf = (filter, strict) => {
    switch (filter.kind) {
      case KINDS.SECURITY:
        return bit(security?.[filter.id]);
      case KINDS.PRIVACY:
        return bit(privacy?.[filter.id]);
      case KINDS.PARENTAL:
        return bit(parental?.[filter.id]);
      case KINDS.CATEGORY:
      case KINDS.SERVICE: {
        const list = lists[filter.kind];
        if (!list) return null;
        // Absent from the list: not blocked.
        return list.has(filter.id) ? entryState(list.get(filter.id), strict) : 0;
      }
      default:
        return null;
    }
  };
  return {
    services: services ? [...services.keys()].slice(0, 1000) : [],
    /** Is the item (category, service) listed in the profile? */
    present(filter) {
      return Boolean(lists[filter.kind]?.has(filter.id));
    },
    state: (filter) => stateOf(filter, false),
    /** For a command: an item without a boolean `active` is unknown (refused). */
    commandState: (filter) => stateOf(filter, true),
  };
}

/**
 * The request that sets `filter` to `enable` on profile `profileId`, given
 * whether the item is listed in the fresh reading: { method, path, body }.
 */
export function requestFor(profileId, filter, enable, { present }) {
  const base = `/profiles/${encodeURIComponent(profileId)}`;
  switch (filter.kind) {
    case KINDS.SECURITY:
      return { method: 'PATCH', path: `${base}/security`, body: { [filter.id]: enable } };
    case KINDS.PRIVACY:
      return { method: 'PATCH', path: `${base}/privacy`, body: { [filter.id]: enable } };
    case KINDS.PARENTAL:
      return { method: 'PATCH', path: `${base}/parentalControl`, body: { [filter.id]: enable } };
    case KINDS.CATEGORY:
    case KINDS.SERVICE: {
      const list = `${base}/parentalControl/${filter.kind === KINDS.CATEGORY ? 'categories' : 'services'}`;
      if (present) {
        return {
          method: 'PATCH',
          path: `${list}/${encodeURIComponent(filter.id)}`,
          body: { active: enable },
        };
      }
      // Not listed: only adding it makes sense (a removal would be a no-op).
      return enable ? { method: 'POST', path: list, body: { id: filter.id, active: true } } : null;
    }
    default:
      return null;
  }
}
