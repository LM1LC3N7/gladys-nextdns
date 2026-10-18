// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// -----------------------------------------------------------------------------

import { PROFILE_ID_PATTERN, REFRESH_INTERVALS } from './constants.js';

// Defaults: they MUST match the `default` values of the manifest.
export const DEFAULTS = Object.freeze({
  refresh_interval: '300',
  allow_commands: false,
  allow_disable_protection: false,
});

/** What an HTTP header accepts as a key: printable ASCII, no space. */
const KEY_PATTERN = /^[\x21-\x7e]+$/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const bool = (value, fallback) => {
  if (value === true || value === 'true' || value === 1 || value === '1') return true;
  if (value === false || value === 'false' || value === 0 || value === '0') return false;
  return fallback;
};

/**
 * The profiles to follow: ids separated by commas, semicolons or spaces.
 * Empty: all of them. -> { ids: Set, invalid: [tokens] } or null.
 */
export function parseProfileFilter(value) {
  const tokens = text(value)
    .split(/[,;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  return {
    ids: new Set(tokens.filter((t) => PROFILE_ID_PATTERN.test(t))),
    invalid: tokens.filter((t) => !PROFILE_ID_PATTERN.test(t)),
  };
}

export function normalizeConfig(raw = {}) {
  raw = raw ?? {};
  const apiKey = typeof raw.api_key === 'string' ? raw.api_key.trim() : '';
  const interval = REFRESH_INTERVALS.includes(String(raw.refresh_interval))
    ? String(raw.refresh_interval)
    : DEFAULTS.refresh_interval;
  const allowCommands = bool(raw.allow_commands, DEFAULTS.allow_commands);
  return {
    apiKey,
    // An invisible character pasted with the key (U+200B...) would make Node
    // refuse the header: said to the user, never sent.
    apiKeyInvalid: apiKey !== '' && !KEY_PATTERN.test(apiKey),
    filter: parseProfileFilter(raw.profiles),
    intervalMs: Number(interval) * 1000,
    allowCommands,
    // Turning a protection off needs both options.
    allowDisable:
      allowCommands && bool(raw.allow_disable_protection, DEFAULTS.allow_disable_protection),
  };
}
