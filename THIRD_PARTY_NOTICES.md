# Third-party notices

This integration follows the project below for reading NextDNS: the
`X-Api-Key` header, the endpoints (`/profiles`, `/profiles/:id`, the
`analytics/status` and `analytics/encryption` answers and how their totals
and shares are computed), the names of the security, privacy and parental
control settings, the ids of the parental control categories and services,
and the requests that change them (PATCH of the setting, PATCH or POST of a
category or service). Nothing of it is installed at runtime, and no line of
it is copied: it is Python, this integration is JavaScript
(`src/nextdns/client.js`, `src/nextdns/parse.js`, `src/filters.js`).

## bieniu/nextdns

<https://github.com/bieniu/nextdns>, version 5.1.0 (tag `5.1.0`, commit
`3da27e4`, 2026-09-13), licensed under the Apache License, Version 2.0. The
project ships no NOTICE file. The full text of the license is the `LICENSE`
file of this repository (the same Apache License 2.0).

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## The NextDNS API documentation

<https://nextdns.github.io/api/>: authentication, the `{ data, meta }` and
`{ errors }` envelopes, the `from` parameter, pagination and the devices
analytics. Only the documented behaviour is reproduced.

## LM1LC3N7/gladys-portainer

The structure of the app, the handler wiring, the retry and pause policy and
the command safety follow an integration of the same author, under the
Apache License 2.0 of this repository.
