// -----------------------------------------------------------------------------
// NextDnsError: every failure of a request to the NextDNS API, with a code
// the app maps to a status, a retry policy or a message. Messages never carry
// the API key.
// -----------------------------------------------------------------------------

export const CODES = Object.freeze({
  UNREACHABLE: 'unreachable', // no connection
  TIMEOUT: 'timeout', // no answer in time
  HTTP: 'http', // an HTTP status other than 2xx (see `status`)
  API: 'api', // a 2xx answer carrying { errors: [...] } (a user error of the API)
  BAD_ANSWER: 'bad_answer', // not the JSON expected
  TOO_LARGE: 'too_large', // answer above the size cap
  CLOSED: 'closed', // the client was replaced (new configuration)
  NO_TIME: 'no_time', // the deadline of a command left no room: not sent
});

export class NextDnsError extends Error {
  constructor(code, message, { status, retryAfterMs, path, json, apiCode } = {}) {
    super(message);
    this.name = 'NextDnsError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (retryAfterMs !== undefined && retryAfterMs !== null) this.retryAfterMs = retryAfterMs;
    if (path !== undefined) this.path = path;
    /** The body was JSON (the API itself answered, not a proxy in front of it). */
    if (json !== undefined) this.json = json;
    if (apiCode !== undefined) this.apiCode = apiCode;
  }
}

/**
 * The API key refused: HTTP 401, or 403 answered in JSON by the API itself,
 * on GET /profiles (the one request every key may make). A 403 page of a
 * proxy or CDN in front of the API (HTML) is a passing failure. Final: never
 * retried without a user action (configuration saved, "Test the connection").
 */
export const isKeyRefused = (err) =>
  err?.code === CODES.HTTP &&
  err.path === '/profiles' &&
  (err.status === 401 || (err.status === 403 && err.json === true));

/** Too many requests, or a server error: a pause kept across restarts. */
export const isBusy = (err) => err?.code === CODES.HTTP && err.status === 429;
export const isServerError = (err) => err?.code === CODES.HTTP && err.status >= 500;
