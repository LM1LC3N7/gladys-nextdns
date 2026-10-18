# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- First version, never tested against a real NextDNS account: NextDNS
  profiles through the official API and an API key (`X-Api-Key` header, sent
  only to api.nextdns.io).
- One device per profile: queries and blocked queries of the last 24 hours,
  blocked share, share of queries over an encrypted DNS transport, devices
  seen, and the state of each filter (security, disguised trackers, safe
  search, YouTube restricted mode, bypass blocking, categories, the blocked
  services of the profile), all read only.
- The "Filter command" select, off by default (`allow_commands`); turning a
  protection off also needs `allow_disable_protection`. Each command reads the
  profile again and decides on that reading only; nothing is sent past 3.5 s.
- Reading every 5 minutes by default (up to every hour), one request at a
  time; a refused key stops everything until the user acts; HTTP 429 and 5xx
  pauses kept across restarts.
- Button "Test the connection".

[Unreleased]: https://github.com/LM1LC3N7/gladys-nextdns/commits/main
