// -----------------------------------------------------------------------------
// The only network access of the integration: one request on node:https (or
// node:http for the loopback tests). A deadline for the whole exchange, a size
// cap on the body, no redirect followed, the certificate always checked.
// Resolves { status, headers, body } for any status; rejects a NextDnsError
// for the transport failures, with `notSent` when nothing left for sure.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { CODES, NextDnsError } from './errors.js';

function transportError(err) {
  const code = String(err?.code ?? '');
  return new NextDnsError(CODES.UNREACHABLE, code || 'Connection failed');
}

/**
 * @param {string} url absolute http(s) URL
 * @param {object} options
 * @param {'GET'|'PATCH'|'POST'} [options.method]
 * @param {Record<string, string>} [options.headers]
 * @param {string} [options.body] JSON text
 * @param {number} options.timeout ms for the whole exchange
 * @param {number} [options.sendWithin] ms to have the connection up, else not sent
 * @param {number} options.maxBytes body size cap
 * @param {() => void} [options.onSent] called once the connection is up (the request may leave)
 */
export function httpRequest(
  url,
  { method = 'GET', headers = {}, body, timeout, sendWithin, maxBytes, onSent } = {},
) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    let settled = false;
    let req = null;
    // Until the connection (TLS included) is up, nothing of the request has
    // left: a failure then is "not sent" for sure (see the commands).
    let connected = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(sendTimer);
      if (error) {
        if (!connected) error.notSent = true;
        req?.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(
      () =>
        finish(new NextDnsError(CODES.TIMEOUT, `No answer within ${Math.round(timeout / 1000)} s`)),
      timeout,
    );
    // A command must leave before its deadline, or not at all.
    const sendTimer =
      sendWithin === undefined
        ? null
        : setTimeout(() => {
            if (!connected) {
              finish(new NextDnsError(CODES.TIMEOUT, 'Not connected in time: request not sent'));
            }
          }, sendWithin);

    const markSent = () => {
      if (connected || settled) return;
      connected = true;
      clearTimeout(sendTimer);
      onSent?.();
    };

    try {
      const payload = body === undefined ? null : Buffer.from(body, 'utf8');
      req = lib.request(
        {
          method,
          hostname: target.hostname,
          port: target.port || undefined,
          path: `${target.pathname}${target.search}`,
          headers: {
            accept: 'application/json',
            ...(payload
              ? { 'content-type': 'application/json', 'content-length': payload.length }
              : {}),
            ...headers,
          },
          // The certificate of api.nextdns.io is always checked.
          rejectUnauthorized: true,
          agent: false,
        },
        (res) => {
          markSent();
          const chunks = [];
          let size = 0;
          res.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              finish(new NextDnsError(CODES.TOO_LARGE, `Answer above ${maxBytes} bytes`));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () =>
            finish(null, {
              status: res.statusCode,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on('error', (err) => finish(transportError(err)));
        },
      );
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          markSent();
          return;
        }
        socket.once(lib === https ? 'secureConnect' : 'connect', markSent);
      });
      req.on('error', (err) => finish(transportError(err)));
      if (payload) req.write(payload);
      req.end();
    } catch (err) {
      // A header Node refuses (an invisible character in the key): a
      // failure, never a crash.
      finish(transportError(err));
    }
  });
}
