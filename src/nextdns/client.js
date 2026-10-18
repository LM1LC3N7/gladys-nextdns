// -----------------------------------------------------------------------------
// The official NextDNS API (https://nextdns.github.io/api/), with an API key:
//   GET   /profiles                                   the profiles of the account
//   GET   /profiles/:id                               settings, security, parental control
//   GET   /profiles/:id/analytics/status?from=-1d     queries and blocked, 24 h
//   GET   /profiles/:id/analytics/encryption?from=-1d encrypted queries, 24 h
//   GET   /profiles/:id/analytics/devices?from=-1d    devices seen, 24 h
//   PATCH / POST under /profiles/:id/...              a filter on or off (src/filters.js)
// The key goes in the `X-Api-Key` header only, and only to api.nextdns.io
// (fixed here, never configurable; never in a URL, never in a log).
// -----------------------------------------------------------------------------

import { API_ORIGIN, LIMITS, MAX_BYTES, TIMEOUTS } from '../constants.js';
import { CODES, NextDnsError } from './errors.js';
import { httpRequest } from './http.js';
import {
  parseDevices,
  parseEncryption,
  parseProfile,
  parseProfiles,
  parseStatus,
} from './parse.js';

/** Room a request needs before its deadline, or it is not sent at all. */
const MIN_SEND_MS = 300;
/** The analytics window: the last 24 hours. */
const LAST_DAY = '-1d';

/** Seconds of a Retry-After header (delta form only), in ms, or null. */
const retryAfterMs = (value) => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw.trim())) return null;
  return Number(raw.trim()) * 1000;
};

const notSent = (err) => {
  if (err && typeof err === 'object') err.notSent = true;
  return err;
};

const isJsonType = (headers) => /application\/json/i.test(String(headers?.['content-type'] ?? ''));

/** The first error of an `{ errors: [...] }` envelope, or null. */
function apiErrorOf(json) {
  const errors = json?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const code = typeof errors[0]?.code === 'string' ? errors[0].code.slice(0, 60) : 'error';
  return code;
}

export class NextDnsClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {Function} [options.request] the HTTP transport (tests inject a fake NextDNS)
   * @param {() => number} [options.now]
   */
  constructor({ apiKey, request = httpRequest, now = Date.now }) {
    this.apiKey = apiKey;
    this.request = request;
    this.now = now;
    this.closed = false;
  }

  close() {
    this.closed = true;
  }

  timeoutFor(deadline, fallback) {
    if (deadline === undefined) return fallback;
    const remaining = deadline - this.now();
    if (remaining < MIN_SEND_MS) {
      throw notSent(new NextDnsError(CODES.NO_TIME, 'No time left: request not sent'));
    }
    return Math.min(fallback, remaining);
  }

  /**
   * One HTTP exchange. Resolves the parsed JSON (null for 204); rejects a
   * NextDnsError (HTTP with its status, API for a 2xx carrying errors).
   */
  async call(path, { method = 'GET', query, body, deadline, sendWithin, onSent } = {}) {
    if (this.closed) throw notSent(new NextDnsError(CODES.CLOSED, 'Client closed'));
    const url = new URL(`${API_ORIGIN}${path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    const timeout = this.timeoutFor(deadline, TIMEOUTS.API);
    const response = await this.request(url.toString(), {
      method,
      headers: { 'x-api-key': this.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout,
      sendWithin: sendWithin === undefined ? undefined : Math.min(sendWithin, timeout),
      maxBytes: MAX_BYTES,
      onSent,
    });
    const text = response.body?.toString('utf8') ?? '';
    let json;
    let parsed = false;
    if (text) {
      try {
        json = JSON.parse(text);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    if (response.status < 200 || response.status > 299) {
      throw new NextDnsError(CODES.HTTP, `HTTP ${response.status}`, {
        status: response.status,
        retryAfterMs: retryAfterMs(response.headers?.['retry-after']),
        path,
        // The API itself answered (an `errors` envelope), not a proxy page.
        json: parsed && isJsonType(response.headers) && apiErrorOf(json) !== null,
        apiCode: parsed ? (apiErrorOf(json) ?? undefined) : undefined,
      });
    }
    if (response.status === 204 || !text) return null;
    if (!parsed) throw new NextDnsError(CODES.BAD_ANSWER, 'Not JSON', { path });
    // A user error is answered 200 with { errors } (documented).
    const apiCode = apiErrorOf(json);
    if (apiCode) {
      throw new NextDnsError(CODES.API, `API error ${apiCode}`, {
        status: response.status,
        path,
        apiCode,
      });
    }
    return json;
  }

  async profiles() {
    const parsed = parseProfiles(await this.call('/profiles'));
    if (!parsed) throw new NextDnsError(CODES.BAD_ANSWER, 'Not a list of profiles');
    return parsed;
  }

  profilePath(id) {
    return `/profiles/${encodeURIComponent(id)}`;
  }

  async profile(id, { deadline } = {}) {
    const parsed = parseProfile(await this.call(this.profilePath(id), { deadline }));
    if (!parsed) throw new NextDnsError(CODES.BAD_ANSWER, 'Not a profile');
    return parsed;
  }

  async analytics(id, type, parse, query = {}) {
    const json = await this.call(`${this.profilePath(id)}/analytics/${type}`, {
      query: { from: LAST_DAY, ...query },
    });
    const parsed = parse(json);
    if (!parsed) throw new NextDnsError(CODES.BAD_ANSWER, `Not ${type} analytics`);
    return parsed;
  }

  status(id) {
    return this.analytics(id, 'status', parseStatus);
  }

  encryption(id) {
    return this.analytics(id, 'encryption', parseEncryption);
  }

  devices(id) {
    return this.analytics(id, 'devices', parseDevices, { limit: String(LIMITS.DEVICES_PAGE) });
  }

  /**
   * A filter request ({ method, path, body } of src/filters.js). The
   * deadline bounds the moment it is SENT (no room left: not sent).
   */
  async command({ method, path, body }, { deadline, onSent } = {}) {
    const sendWithin = this.timeoutFor(deadline, TIMEOUTS.API);
    await this.call(path, { method, body, sendWithin, onSent });
  }
}
