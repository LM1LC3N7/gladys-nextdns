# TODO — NextDNS v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`,
  `npx github:GladysAssistant/integration-store .`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No forum topic of its own: the claim is in /t/10385 (post #262, lot 7).

## Status

- [x] **Milestone 1 — core** (2026-10-18): official NextDNS API client (API key
      in `X-Api-Key`, only to api.nextdns.io), profiles, settings, status /
      encryption / devices analytics of the last 24 h; one device per profile
      (queries, blocked, blocked %, encrypted %, devices seen, filter states
      read only, "Filter command" select); commands off by default, turning
      off behind a second option, fresh read before acting, 3.5 s budget,
      answer at 4.3 s at most; key refusal final and remembered (HMAC);
      429 / 5xx pauses persisted and capped; button "Test the connection";
      docs en/fr. Tested with unit tests against the SDK's fake Gladys, a fake
      NextDNS in memory and loopback HTTP servers. **Never tested against a
      real NextDNS account.** No Docker on this PC: no e2e test in a container.
- [ ] **Milestone 2 — real account** (a tester with NextDNS): record real
      answers as fixtures (key removed), fix what differs. To check first:
  - what the API answers to a wrong key (401 or 403, JSON `errors`?), and
    whether a CDN in front of it ever answers 403 / 429 / 524 in HTML;
  - whether the API ever answers 429, and with a Retry-After;
  - `analytics/status` values (`default`, `blocked`, `allowed`, `relayed`?)
    and whether `from=-1d` is the rolling last 24 h;
  - `analytics/devices`: `__UNIDENTIFIED__` id, `queries` per device,
    pagination above 500;
  - the shape of `parentalControl.services` / `categories` (`active`
    present?), PATCH answers (204 or 200 `{ data }`), POST of an item already
    listed (`duplicate` error?);
  - the newer security keys (`dataDropServices`, `tunnelingEndpoints`…): sent
    by the API for every profile?;
  - the text/select feature in the Gladys dashboard and in the "Control a
    device" scene action with 60+ options; the reset to "none".
- [ ] **Milestone 3 — more**: blocklists (count, add / remove), enabling a
      service not listed yet (the 43 known ids), allowlist / denylist entries,
      logs on / off, a "connected to NextDNS" check of the Gladys host
      (`test.nextdns.io`), time series for charts.
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, GHCR package public (the main session publishes),
      then the store validator once the image is published (at milestone 1
      its only error is the `docker_image` not yet pullable from GHCR).

## Decisions

- **Duplicate check**: done by the main session before the batch (post #262
  of /t/10385); not repeated by the development agent.
- **Reuse**: bieniu/nextdns 5.1.0 (Apache-2.0, commit `3da27e4`) is the
  reference for the endpoints, the setting names, the category and service
  ids, the ratios and the requests that change a filter; the official API
  documentation for the envelopes, `from`, pagination and devices. Notices in
  `THIRD_PARTY_NOTICES.md`, copied into the image. No runtime dependency
  besides the SDK.
- **Version**: 0.1.0 set by hand in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag; the first patch release gives 0.1.1.
- **External ids**: `profile:<NextDNS profile id>` (stable; the name may
  change). Features `queries`, `blocked`, `blocked_ratio`, `encrypted_ratio`,
  `devices`, `command`, and one per filter: `filter-security-<kebab name>`,
  `filter-privacy-disguised-trackers`, `filter-parental-<kebab name>`,
  `filter-category-<id>`, `filter-service-<id>` (ids of the API, checked
  against `[a-z0-9-]`).
- **One device per profile** (brief). The services of a profile are those
  listed in it; a republished device keeps the service features it was
  created with (from `gladys.devices`), so a service removed in NextDNS keeps
  its feature at 0 and the history; at most 60 services.
- **Feature types and units** (only the core's): counts
  `counter-sensor`/`integer` without unit; shares `unknown`/`unknown` without
  unit (no core category lists a percent for a share of queries, named
  "(%)"); filters `unknown`/`binary` read only (1 on); the command
  `text`/`select` (string `supported_options`, core 4.86+). Prudent default:
  a wrong category would be frozen at creation.
- **No switch** (lesson of lot 6): the core exposes every `switch` to the
  voice assistants, MCP and the "turn off" scene actions; "turn everything
  off" must never remove a protection. A select rather than buttons: one
  feature per profile instead of two per filter (about 60 buttons); labels in
  English (the core takes one string per option).
- **Command safety**: turning on needs `allow_commands`; turning off (any
  filter: security, privacy, parental control, category, service) needs
  `allow_disable_protection` too (both off by default), checked when the
  command arrives AND just before sending. Commands are chained per profile,
  keep the client of the moment they arrived, read `GET /profiles/:id` with a
  deadline and decide on that answer only (never merged with memory): an
  unknown state (key absent, not a boolean, list unreadable) is refused; the
  state asked already, nothing sent. Nothing is sent once 3.5 s have passed;
  the connection must be up before that deadline, else "not sent". Gladys is
  answered at NextDNS's answer or 4.3 s after the command; a command that may
  have left is "sent, without confirmation" (never "not sent"), the profile
  is read again 3 s later. A reading crossed by a command keeps the
  command's result (version per profile). The select is put back on "none"
  1.5 s after each command (`publishStates`, not deduplicated).
- **Adding a category / service**: PATCH `{ active }` when listed, POST
  `{ id, active: true }` when not (the library POSTs after a 404; here the
  fresh reading decides). Turning off one not listed: already off.
- **Key refusal**: HTTP 401, or 403 with an `errors` JSON envelope, on
  `GET /profiles` is final (the library maps 403 to an invalid key); an
  HMAC-SHA-256 of the key, keyed with a random salt generated once in
  `/data`, is kept there (never the key); a restart or a reconnection to
  Gladys does not send it again; saving the configuration or "Test the
  connection" (25 s) tries once. A 403 page that is not the API's JSON (a
  proxy, a CDN) is a passing failure (lesson of wave 1).
- **Retries and pauses**: a failure is never read again faster than the
  reading interval (lesson of lot 6); transient failures double up to 1 h.
  HTTP 429, met by any request (loop, command, the reading after a command),
  pauses every path for its Retry-After bounded 1 min to 6 h, and at least the
  interval. 5xx on `GET /profiles` pauses too (Retry-After honoured up to 6
  h). Both pauses are kept in `/data`, capped at 6 h when read back; only the
  user lifts them. A 5xx or other failure of a per-profile request leaves
  only that figure unread (lesson of wave 3); the status says how many
  profiles were not read completely.
- **Reconnection to Gladys** (`connected`): same configuration, nothing is
  read again: the client, the pause and the refusal stay; the caches that
  mirror Gladys (status, Discovery key, badges, published values) are
  emptied and sent again.
- **Reading pace**: every 5 min by default (5, 10, 15, 30, 60 min), 4
  requests per profile, one at a time; 10 profiles at most. No documented
  rate limit: prudent.
- **Rate of states**: change-only (own cache + `publishChangedStates`), a
  sliding window under 250/min; a profile whose changes do not fit waits for
  the next round. Badges `cloud` / `unreachable`.
- **Secrets**: the API key is a `secret` field (kept in clear in the Gladys
  database, masked in the UI: never "encrypted"), sent only in the
  `X-Api-Key` header to the fixed origin; never in a URL, a log or `/data`
  (tested). A key with a space or an invisible character is refused in the
  configuration; a header Node refuses anyway is a failure, never a crash.
  The docs say the key gives access to the whole account.
- **Devices seen**: identified devices with at least one query in 24 h, one
  page of 500 (cap documented).
- `gladys_version >=5.1.0`, transports `["cloud"]`, categories `network`,
  `security`. Single container.
