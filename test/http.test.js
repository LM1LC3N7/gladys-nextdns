// -----------------------------------------------------------------------------
// The transport (src/nextdns/http.js) against loopback HTTP servers: no
// redirect followed, size cap, deadline, "not sent" only when nothing left.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { httpRequest } from '../src/nextdns/http.js';
import { CODES } from '../src/nextdns/errors.js';

async function serve(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const OPTIONS = { timeout: 2_000, maxBytes: 1024 };

test('a request: method, headers, JSON body; any status resolves', async () => {
  let seen;
  const server = await serve((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen = {
        method: req.method,
        url: req.url,
        key: req.headers['x-api-key'],
        type: req.headers['content-type'],
        body,
      };
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end('{"errors":[{"code":"forbidden"}]}');
    });
  });
  let sent = false;
  const response = await httpRequest(`${server.url}/profiles/abc123/security?x=1`, {
    ...OPTIONS,
    method: 'PATCH',
    headers: { 'x-api-key': 'k' },
    body: JSON.stringify({ csam: true }),
    onSent: () => {
      sent = true;
    },
  });
  await server.close();
  assert.equal(response.status, 403);
  assert.equal(response.body.toString(), '{"errors":[{"code":"forbidden"}]}');
  assert.deepEqual(seen, {
    method: 'PATCH',
    url: '/profiles/abc123/security?x=1',
    key: 'k',
    type: 'application/json',
    body: '{"csam":true}',
  });
  assert.ok(sent);
});

test('a redirect is not followed', async () => {
  let hits = 0;
  const server = await serve((req, res) => {
    hits += 1;
    res.writeHead(302, { location: 'http://example.org/steal' });
    res.end();
  });
  const response = await httpRequest(`${server.url}/profiles`, OPTIONS);
  await server.close();
  assert.equal(response.status, 302);
  assert.equal(hits, 1);
});

test('an answer above the cap is refused', async () => {
  const server = await serve((req, res) => {
    res.end('x'.repeat(5000));
  });
  await assert.rejects(httpRequest(`${server.url}/`, OPTIONS), { code: CODES.TOO_LARGE });
  await server.close();
});

test('no answer in time: a timeout, sent (the connection was up)', async () => {
  const server = await serve(() => {});
  const err = await httpRequest(`${server.url}/`, { ...OPTIONS, timeout: 200 }).catch((e) => e);
  assert.equal(err.code, CODES.TIMEOUT);
  assert.notEqual(err.notSent, true, 'it may have left');
  await server.close();
});

test('no connection: unreachable, not sent', async () => {
  // A port nobody listens on.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const err = await httpRequest(`http://127.0.0.1:${port}/`, OPTIONS).catch((e) => e);
  assert.equal(err.code, CODES.UNREACHABLE);
  assert.equal(err.notSent, true);
});

test('a header Node refuses is a failure, never a crash', async () => {
  const err = await httpRequest('http://127.0.0.1:9/', {
    ...OPTIONS,
    headers: { 'x-api-key': 'a\nb' },
  }).catch((e) => e);
  assert.equal(err.code, CODES.UNREACHABLE);
  assert.equal(err.notSent, true);
});
