# NextDNS

Your NextDNS profiles in Gladys, through the official NextDNS API and the API
key of your account. Each profile becomes a Gladys device:

- **Queries (24 h)** and **Blocked queries (24 h)**: the DNS queries and the
  blocked queries of the last 24 hours;
- **Blocked queries (%)**: the blocked share;
- **Encrypted queries (%)**: the share of the queries that came over an
  encrypted DNS transport (DNS-over-HTTPS, DNS-over-TLS, DNS-over-QUIC…);
- **Devices seen (24 h)**: the identified devices that made at least one query
  (unidentified queries do not count);
- the state of each **filter** (1 on, 0 off): security protections, disguised
  trackers blocking, safe search, YouTube restricted mode, bypass blocking,
  categories (porn, gambling, dating, piracy, social networks, online gaming,
  video streaming) and the blocked services of your profile (TikTok,
  Fortnite…);
- the **Filter command** select, to turn a filter on or off (off by default,
  see Commands).

> **This integration has never been tested against a real NextDNS account.**
> This first version was written from the official documentation of the
> NextDNS API and the nextdns Python library 5.1.0, and tested only against a
> fake NextDNS. Tell on the Gladys forum what works and what does not.

Unofficial integration, not affiliated with NextDNS.

## Configuration

- **API key**: on [my.nextdns.io](https://my.nextdns.io/account), **Account**,
  **API** section, at the bottom of the page. Kept by Gladys in its database,
  never shown again, sent only to `api.nextdns.io`, in the `X-Api-Key` header
  (never in an address, never in a log, never in the `/data` volume). Beware:
  the key gives access to the whole NextDNS account (NextDNS offers no
  read-only key).
- **Profiles**: the ids of the profiles to follow (the 6 characters of
  `my.nextdns.io/<id>`), separated by commas; empty, every profile of the
  account, 10 at most.
- **Refresh**: every 5 minutes (default) to every hour. Each reading makes 4
  requests per profile, one after the other.
- **Allow the filter commands** and **Allow turning protections off**: off by
  default (see Commands).

Then open the **Discovery** tab and create the profiles to follow.

NextDNS only has figures when the **Logs** are on in the profile: otherwise
the queries stay at 0.

## Commands

- By default Gladys only reads. A filter is **never a switch**: Gladys hands
  every switch to the voice assistants (Google Home, Alexa, HomeKit), MCP and
  the "turn off" scene actions, so "turn everything off" would remove your
  protections. Each filter is a reading, and commands go through the **Filter
  command** select of the profile (dashboard or the "Control a device" scene
  action).
- **Turn on: …** (turning a filter on) needs **Allow the filter commands**.
- **Turn off: …** (turning off a security protection, the tracker blocking or
  a parental control filter) also needs **Allow turning protections off**.
  Without it, Gladys refuses and sends nothing.
- Just before acting, Gladys reads the profile from NextDNS again and decides
  on that reading only: a filter whose state is unknown is refused; a filter
  already in the state asked sends nothing. When the command cannot be checked
  within 3.5 s, nothing is sent and Gladys shows a failure (never an action
  after a failure shown). A command that left without an answer of NextDNS in
  time shows as a failure saying "sent, not confirmed yet" (never "not
  sent"); the state of the filter follows the answer, and the profile is read
  again a few seconds later.
- Only the options of the select of the profile are accepted. The commands
  of a profile run one at a time (the next one waits for the answer to the
  previous one). The select goes back to "—" 1.5 s after each command.
- Unticking an option takes effect at once, even while a reading runs.
- The blocked services are those of your profile: a service added later in
  NextDNS shows in Discovery; press **Update** to add it to the device. A
  service removed keeps its feature (at 0), so that the history is never
  broken.
- The parental control **Recreation Time** is not taken into account: the
  state shown is the setting of the filter, even during a recreation.

## Connection problems

- **Key refused** (HTTP 401, or 403 from the API itself): Gladys does not try
  again by itself, not even after a restart. Copy the key, paste it and save,
  or press **Test the connection**.
- **NextDNS overloaded** (HTTP 429, met by any request) or **server error**
  (HTTP 5xx on the list of the profiles): every request stops, for the chosen
  interval at least (429: 1 minute to 6 hours, as NextDNS asks), even after a
  restart; saving the configuration or pressing **Test the connection** lifts
  the pause.
- **NextDNS unreachable**: retried at the chosen interval, then more and more
  spaced up to one hour. The devices show unreachable meanwhile.
- A secondary request of a profile that fails (encrypted share, devices…)
  never blocks the other figures: the connection status says so.

## Limits

- One NextDNS account per integration, 10 profiles at most (the profiles
  already created first; the connection status says how many are left out),
  60 blocked services per profile.
- Gladys accepts 300 states per minute: the first publication of many
  profiles (up to 10) may take several reading rounds.
- **Devices seen** counts 500 devices at most.
- The shares in % have no unit in Gladys (the core has no "share of queries"
  category): 75 means 75 %.
- Blocklists, the allowlist, the denylist and the settings (logs, cache…) are
  not followed.
