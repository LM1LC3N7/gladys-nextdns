# gladys-nextdns

[Gladys Assistant](https://gladysassistant.com) external integration for
**NextDNS**: each profile becomes a Gladys device with its queries and blocked
queries of the last 24 hours, the blocked share, the share of queries over an
encrypted DNS transport (DoH, DoT, DoQ…), the devices seen and the state of
each filter (security, privacy, parental control). Filter commands are off by
default; turning a protection off needs a second option.
**Unofficial integration, not affiliated with NextDNS. Never tested against a
real NextDNS account yet.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/app.js (NextDnsApp)
                 ├─ src/nextdns/client.js   official API (api.nextdns.io, X-Api-Key)
                 ├─ src/nextdns/http.js     the only network access (node:https)
                 ├─ src/nextdns/parse.js    answers -> totals and shares
                 ├─ src/nextdns/errors.js   error codes, key refusal
                 ├─ src/filters.js          filters: states and requests
                 ├─ src/budget.js           states per minute
                 ├─ src/store.js            /data: refusal, pause (never the key)
                 └─ src/devices.js          one device per profile (pure)
```

- **Authentication**: the API key in the `X-Api-Key` header, only to
  `https://api.nextdns.io` (fixed in the code). HTTP 401, or a JSON 403 of the
  API, on `GET /profiles` is final: a salted HMAC of the key is kept in
  `/data`, nothing is sent again until the configuration is saved or "Test the
  connection" is pressed. A 403 page of a proxy is a passing failure.
- **Reading** (every 5 min by default): `GET /profiles`, then per profile
  `GET /profiles/:id`, `analytics/status`, `analytics/encryption` and
  `analytics/devices` (`from=-1d`), one request at a time. HTTP 429 anywhere
  and 5xx on the profiles pause every path (kept in `/data`, capped when read
  back); a failure is never read again faster than the interval. A secondary
  request that fails only leaves its figure unread.
- **Filters**: read-only `unknown`/`binary` features, never a switch.
  Commands go through one `text`/`select` per profile; turning on needs
  `allow_commands`, turning off needs `allow_disable_protection` too. Each
  command reads the profile again and decides on that reading only; nothing
  is sent past 3.5 s; one that left without an answer is "sent, without
  confirmation".

## Development

```bash
npm install
npm test                                        # node --test, no network (loopback only)
npm run lint && npm run format:check
npm run audit                                   # production dependencies
npm run cover                                   # regenerate cover.png
npx github:GladysAssistant/integration-store .  # store admission checks
```

The tests run against the SDK's fake Gladys and a fake NextDNS
(`test/helpers/fakeNextdns.js`), plus loopback HTTP servers for the
transport. No test touches the real API or the Internet.

## Credits

- [bieniu/nextdns](https://github.com/bieniu/nextdns) 5.1.0 (Apache-2.0): the
  endpoints, the settings and their requests (see
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).
- The official [NextDNS API documentation](https://nextdns.github.io/api/).
- [gladys-portainer](https://github.com/LM1LC3N7/gladys-portainer): the
  structure of the app, the retry policy and the command safety.

## Releasing

**Actions → Release → Run workflow** (patch / minor / major): bumps the
version in `package.json` and the manifest, rolls `CHANGELOG.md`, tags, builds
the multi-arch image to GHCR and publishes the GitHub Release.

## License

Apache-2.0.
