// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys (connection status, buttons, errors).
// Errors thrown to Gladys are English (one language per message, like the
// core's); the statuses and button answers are { en, fr }.
// -----------------------------------------------------------------------------

import { CODES } from './nextdns/errors.js';

const plural = (n, one, many) => (n === 1 ? one : many);
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));

/** Why NextDNS failed, in a few words. */
export function reasonOf(err) {
  switch (err?.code) {
    case CODES.UNREACHABLE:
      return { en: 'no connection', fr: 'pas de connexion' };
    case CODES.TIMEOUT:
    case CODES.NO_TIME:
      return { en: 'no answer in time', fr: 'pas de réponse à temps' };
    case CODES.HTTP:
      return { en: `HTTP error ${err.status}`, fr: `erreur HTTP ${err.status}` };
    case CODES.API:
      return { en: `API error ${err.apiCode}`, fr: `erreur de l’API ${err.apiCode}` };
    case CODES.BAD_ANSWER:
      return { en: 'unexpected answer', fr: 'réponse inattendue' };
    case CODES.TOO_LARGE:
      return { en: 'answer too large', fr: 'réponse trop grande' };
    case CODES.CLOSED:
      return { en: 'configuration changed', fr: 'configuration changée' };
    default:
      return { en: 'error', fr: 'erreur' };
  }
}

const RETRY = (delay) => ({
  en: `Retried in ${minutes(delay)} min.`,
  fr: `Nouvel essai dans ${minutes(delay)} min.`,
});

const join = (...parts) => ({
  en: parts
    .map((p) => p.en)
    .filter(Boolean)
    .join(' '),
  fr: parts
    .map((p) => p.fr)
    .filter(Boolean)
    .join(' '),
});

export const T = {
  status: {
    ok: ({ profiles, failed, missing }) =>
      join(
        {
          en: `NextDNS answers: ${profiles} ${plural(profiles, 'profile', 'profiles')} read.`,
          fr: `NextDNS répond : ${profiles} ${plural(profiles, 'profil lu', 'profils lus')}.`,
        },
        failed > 0
          ? {
              en: `${failed} ${plural(failed, 'profile was', 'profiles were')} not read completely this time.`,
              fr: `${failed} ${plural(failed, 'profil n’a', 'profils n’ont')} pas été lus entièrement cette fois.`,
            }
          : {},
        missing.length > 0
          ? {
              en: `Not found in the account: ${missing.join(', ')}.`,
              fr: `Introuvables dans le compte : ${missing.join(', ')}.`,
            }
          : {},
      ),
    noProfile: {
      en: 'NextDNS answers, but no profile matches: check the profile ids of the configuration (empty: every profile of the account).',
      fr: 'NextDNS répond, mais aucun profil ne correspond : vérifiez les identifiants de profils de la configuration (vide : tous les profils du compte).',
    },
    missingKey: {
      en: 'Type the API key of your NextDNS account (my.nextdns.io, Account, API).',
      fr: 'Saisissez la clé d’API de votre compte NextDNS (my.nextdns.io, Account, API).',
    },
    keyInvalid: {
      en: 'The API key holds a space or an invisible character (copied with it?): paste it again, only the key.',
      fr: 'La clé d’API contient une espace ou un caractère invisible (copié avec ?) : collez-la de nouveau, la clé seule.',
    },
    profilesInvalid: (tokens) => ({
      en: `These are not NextDNS profile ids (letters and digits, e.g. abc123): ${tokens.join(', ')}.`,
      fr: `Ce ne sont pas des identifiants de profils NextDNS (lettres et chiffres, ex. abc123) : ${tokens.join(', ')}.`,
    }),
    keyRefused: {
      en: 'NextDNS refused the API key (wrong or revoked). Gladys does not try again by itself: copy the key from my.nextdns.io (Account, API), paste it and save, or press "Test the connection".',
      fr: 'NextDNS a refusé la clé d’API (fausse ou révoquée). Gladys ne réessaie pas seul : copiez la clé depuis my.nextdns.io (Account, API), collez-la et enregistrez, ou appuyez sur « Tester la connexion ».',
    },
    busy: (delay) =>
      join(
        {
          en: 'NextDNS asks Gladys to slow down (HTTP 429): every request is paused.',
          fr: 'NextDNS demande à Gladys de ralentir (HTTP 429) : toutes les requêtes sont suspendues.',
        },
        RETRY(delay),
      ),
    serverError: (status, delay) =>
      join(
        {
          en: `NextDNS answers with a server error (HTTP ${status}): every request is paused.`,
          fr: `NextDNS répond par une erreur serveur (HTTP ${status}) : toutes les requêtes sont suspendues.`,
        },
        RETRY(delay),
      ),
    unreachable: (err, delay) =>
      join(
        { en: 'NextDNS does not answer:', fr: 'NextDNS ne répond pas :' },
        reasonOf(err),
        { en: '—', fr: '—' },
        RETRY(delay),
      ),
  },
  test: {
    ok: ({ profiles }) => ({
      en: `Connected: ${profiles} ${plural(profiles, 'profile', 'profiles')}.`,
      fr: `Connecté : ${profiles} ${plural(profiles, 'profil', 'profils')}.`,
    }),
  },
  errors: {
    unknownDevice: 'Unknown device or feature: pick one of this integration',
    readOnly: 'This feature is a reading: use the "Filter command" select of the profile',
    notConnected: 'NextDNS is not connected: see the configuration of the integration',
    invalidValue: 'Invalid value: pick one of the options of the "Filter command" select',
    commandsDisabled:
      'Commands are off: allow them first in the configuration of the integration ("Allow the filter commands")',
    disableRefused:
      'Turning a protection off is refused: allow it first in the configuration of the integration ("Allow turning protections off"). Nothing was sent',
    tooSlow:
      'The command could not be checked in time (Gladys waits 5 s for its answer): nothing was sent, try again',
    unknownState: (err) =>
      `The current state of the filter could not be read${err ? ` (${reasonOf(err).en})` : ''}: nothing was sent`,
    notSent: (err) => `The command could not reach NextDNS (${reasonOf(err).en}): nothing was sent`,
    refused: (err) => `NextDNS refused the command (${reasonOf(err).en})`,
    unconfirmed: (err) =>
      `The command was sent but NextDNS did not confirm it (${reasonOf(err).en}): the filter is read again in a moment`,
    configChanged: 'The configuration changed meanwhile: nothing was sent, try again',
    busy: 'NextDNS asked Gladys to slow down: nothing was sent, try again later',
    busyRefused:
      'NextDNS refused the request (HTTP 429, too many requests): nothing was done, Gladys pauses its requests',
    testTooLong:
      'NextDNS has not answered yet: see the connection status in a moment (nothing else to do)',
  },
};
