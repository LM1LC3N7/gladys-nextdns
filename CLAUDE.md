# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/app.test.js              # one file
node --test --test-name-pattern "429"     # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only (src/handlers.js registers the handlers)
src/handlers.js                   every SDK handler, wired to the app (shared with the tests)
src/app.js                        NextDnsApp: lifecycle, reading loop, commands
src/nextdns/client.js             official NextDNS API (api.nextdns.io, X-Api-Key)
src/nextdns/http.js               the only network access (node:https)
src/nextdns/parse.js              answers -> totals and shares
src/nextdns/errors.js             NextDnsError, key refusal
src/filters.js                    the filters: catalog, states, requests (pure)
src/budget.js                     the states-per-minute window (300/min limit of Gladys)
src/store.js                      /data: key refusal, pause (never the key)
src/devices.js                    the Gladys devices and their external ids (pure)
src/config.js                     DEFAULTS (mirror the manifest defaults) + normalization
src/constants.js, src/i18n.js     keys, limits, timings; runtime texts (en/fr)
gladys-assistant-integration.json manifest: name, config_schema, actions...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test: SDK fake Gladys, fake NextDNS, loopback servers
scripts/cover.mjs                 generates cover.png (plain Node)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

Safety rules of this integration (TODO.md, "Decisions"): never a `switch`
feature (the core gives switches to voice assistants and "turn everything
off"): filters are read-only `unknown`/`binary`, commands go through one
`text`/`select` per profile; turning on needs `allow_commands`, turning off
needs `allow_disable_protection` too; a command reads the profile again,
decides on that reading only and sends nothing past 3.5 s; the API key goes
only to api.nextdns.io in the `X-Api-Key` header; a refused key is never
retried without a user action; 429 / 5xx pauses are kept in `/data`; a
failure is never read again faster than the interval.

## Rules

- **External ids are forever.** Build them with
  `gladys.externalIds(type, platformId)`, `platformId` being the unique id the
  platform gives the device, never a label. Here: the NextDNS profile id, and
  feature keys `filter-<kind>-<id>`. Gladys keys devices, their history,
  scenes and dashboards on them: changing one creates a new device and
  orphans the old one. The same goes for every key users store: manifest
  `config_schema`, `actions`, feature keys.
- **The container rootfs is read-only.** Write only under `/data`, the one
  writable volume. Never log tokens, passwords or API keys.
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` in `package.json` or in the manifest, nor the `docker_image` tag,
  by hand — except on the README's hand-pushed tag path, which bumps all three
  together before tagging. `test/manifest.test.js` checks they agree.
- **Changelog.** Every user-visible change adds a line under `## [Unreleased]`
  in `CHANGELOG.md` (`### Added`, `Changed`, `Fixed`, `Removed`, `Security`).
  Never write a version heading: the Release workflow moves the section, and it
  becomes the notes of the GitHub Release.
- **Manifest.** Texts are multi-language objects `{ "en": ..., "fr": ... }`:
  `label`, `description` and `placeholder` alike, never a plain string. The
  catalog `description` holds 10 to 100 characters per language. A field the
  older cores do not know needs a higher `gladys_version` minimum
  (`categories`: 4.86.0; `widgets`, `scene_triggers`, `scene_actions`,
  `type: "provider"`: 5.1.0). `test/manifest.test.js` ties the manifest to the
  code: change both sides together.
- **Secrets.** A `secret` field is masked in the UI but kept in clear in the
  Gladys database: never write that it is encrypted.
- **User-facing text** is bilingual (English and French): action messages,
  manifest texts, and `docs/en.md` / `docs/fr.md`, kept in sync.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network.
