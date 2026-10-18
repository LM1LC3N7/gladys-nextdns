# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

## [0.1.1] - 2026-10-18

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

### Security

- Unticking a command option applies at once, even while a reading or a
  restart is queued; a command accepted before is refused before sending.
- Only the options of the select of the profile are accepted (no forged
  service), on a followed profile; an item whose state is not a clear
  boolean is refused.
- A command without an answer within 4.3 s is shown as "sent, not confirmed
  yet", and the next command on the profile waits for that answer.

### Fixed

- The select goes back to "none" after the answer, even during a pause; a
  failed reset is sent again by the next round.
- A reading stops at once when a pause starts: the status stays "paused".
- A reconnection to Gladys sends the status and the Discovery again, even
  during a pause; an updated device gets its states again.
- With more than 10 profiles, the created ones are kept and the status says
  how many are left out.
- A reconnection to Gladys during the first reading no longer delays it by
  one interval: only a real narrowing of the permissions stops what is in
  flight, and a first reading cut short starts again at once.

[Unreleased]: https://github.com/LM1LC3N7/gladys-nextdns/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/LM1LC3N7/gladys-nextdns/releases/tag/v0.1.1
