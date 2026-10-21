// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and state names, the status of
// the integration, the answers of the buttons and the command errors. None of
// them ever carries the user name or the password.
// -----------------------------------------------------------------------------

import { FEATURES, STATE } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

/** A number of kWh for a message: at most 3 decimals. */
const kwh = (value) => String(Math.round(value * 1000) / 1000);

/** The start of a fingerprint, enough to compare it with the web page of the charger. */
export const shortFingerprint = (fingerprint) => String(fingerprint ?? '').slice(0, 23);

export const FEATURE_NAMES = {
  [FEATURES.STATUS]: both('Status', 'État'),
  [FEATURES.STATUS_CODE]: both('Status of the charger', 'Statut de la borne'),
  [FEATURES.CONNECTOR]: both('Connector', 'Connecteur'),
  [FEATURES.CHARGING_STATE]: both('Charging state', 'État de charge'),
  [FEATURES.PLUGGED]: both('Vehicle plugged in', 'Véhicule branché'),
  [FEATURES.PAUSED]: both('Charge paused', 'Charge en pause'),
  [FEATURES.POWER]: both('Power', 'Puissance'),
  [FEATURES.CURRENT_L1]: both('Current L1', 'Courant L1'),
  [FEATURES.CURRENT_L2]: both('Current L2', 'Courant L2'),
  [FEATURES.CURRENT_L3]: both('Current L3', 'Courant L3'),
  [FEATURES.VOLTAGE_L1]: both('Voltage L1', 'Tension L1'),
  [FEATURES.VOLTAGE_L2]: both('Voltage L2', 'Tension L2'),
  [FEATURES.VOLTAGE_L3]: both('Voltage L3', 'Tension L3'),
  [FEATURES.STATION_MAX]: both('Maximum station current', 'Courant maximal de la borne'),
  [FEATURES.CURRENT_SET]: both('Charging current set', 'Courant de charge réglé'),
  [FEATURES.ENERGY_INDEX]: both('Energy index', "Index d'énergie"),
  [FEATURES.TEMPERATURE]: both('Temperature', 'Température'),
  [FEATURES.ERROR]: both('Error reported', 'Erreur signalée'),
  [FEATURES.PAUSE]: both('Pause charging', 'Mettre la charge en pause'),
  [FEATURES.RESUME]: both('Resume charging', 'Reprendre la charge'),
  [FEATURES.SET_CURRENT]: both('Set the charging current', 'Régler le courant de charge'),
};

export const STATE_NAMES = {
  [STATE.STANDBY]: both('No vehicle', 'Aucun véhicule'),
  [STATE.CONNECTED]: both('Vehicle plugged in, not charging', 'Véhicule branché, sans charge'),
  [STATE.CHARGING]: both('Charging', 'En charge'),
  [STATE.ERROR]: both('Charger error', 'Erreur de la borne'),
  [STATE.UNKNOWN]: both('Unknown state', 'État inconnu'),
  [STATE.OFFLINE]: both('Charger unreachable', 'Borne injoignable'),
};

/** A vehicle plugged in with the charge paused (maximum station current at 0). */
export const PAUSED = both(
  'Vehicle plugged in, charge paused',
  'Véhicule branché, charge en pause',
);

/** The integration status, the buttons and the logs a user may read. */
export const T = {
  noHost: both(
    'Enter the IP address of your Alfen charger and its password, then save.',
    "Saisissez l'adresse IP de votre borne Alfen et son mot de passe, puis enregistrez.",
  ),
  invalidHost: (typed) =>
    both(
      `"${typed}" is not an IP address nor a host name.`,
      `« ${typed} » n'est ni une adresse IP ni un nom d'hôte.`,
    ),
  credentialsInHost: both(
    'The address holds a user name or a password ("…@"): enter the address alone, and the credentials in their own fields.',
    "L'adresse contient un nom d'utilisateur ou un mot de passe (« …@ ») : saisissez l'adresse seule, et les identifiants dans leurs champs.",
  ),
  noPassword: both(
    'Enter the password of the charger (the one of the Alfen app, MyEve or Eve Connect), then save.',
    "Saisissez le mot de passe de la borne (celui de l'application Alfen, MyEve ou Eve Connect), puis enregistrez.",
  ),
  badSecret: both(
    'The user name and the password must be plain ASCII, 256 characters at most.',
    "Le nom d'utilisateur et le mot de passe doivent être en ASCII simple, 256 caractères au plus.",
  ),
  connecting: both('Reading the charger…', 'Lecture de la borne…'),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (host, wait) =>
    both(
      `No answer from ${host} (next try in ${wait.en}). Check the address and that the charger is on the network.`,
      `Pas de réponse de ${host} (nouvel essai dans ${wait.fr}). Vérifiez l'adresse et que la borne est sur le réseau.`,
    ),
  failing: (reason, wait) =>
    both(
      `The charger answers with an error (${reason}): next try in ${wait.en}.`,
      `La borne répond par une erreur (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  sessionLost: (wait) =>
    both(
      `The charger closed the session (another app logged in, such as the Alfen app, MyEve or Eve Connect?): next try in ${wait.en}.`,
      `La borne a fermé la session (une autre application connectée, comme l'application Alfen, MyEve ou Eve Connect ?) : nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `The charger asks to slow down (HTTP 429): pause of ${wait.en}.`,
      `La borne demande de ralentir (HTTP 429) : pause de ${wait.fr}.`,
    ),
  serverError: (wait) =>
    both(
      `The charger answered with a server error (HTTP 5xx): pause of ${wait.en}.`,
      `La borne a répondu par une erreur serveur (HTTP 5xx) : pause de ${wait.fr}.`,
    ),
  authRefused: (wait) =>
    both(
      `The charger refused the user name or the password (or another session was open on it): check them, then save. Next try in ${wait.en}.`,
      `La borne a refusé le nom d'utilisateur ou le mot de passe (ou une autre session y était ouverte) : vérifiez-les, puis enregistrez. Nouvel essai dans ${wait.fr}.`,
    ),
  certificateChanged: (fingerprint) =>
    both(
      `The certificate of the charger changed (now ${shortFingerprint(fingerprint)}…): nothing is sent to it, the password neither. If you replaced or updated the charger, click "Trust the new certificate".`,
      `Le certificat de la borne a changé (maintenant ${shortFingerprint(fingerprint)}…) : rien ne lui est envoyé, le mot de passe non plus. Si vous avez remplacé ou mis à jour la borne, cliquez sur « Faire confiance au nouveau certificat ».`,
    ),
  storage: both(
    'The certificate of the charger could not be kept in /data: the password is not sent until it can (check the storage of Gladys).',
    "Le certificat de la borne n'a pas pu être gardé dans /data : le mot de passe n'est pas envoyé tant que ce n'est pas possible (vérifiez le stockage de Gladys).",
  ),
  pausedKept: (amps) =>
    both(
      `Paused by a maximum station current of 0 A; ${amps} A before the pause, the value a resume writes back (to set in the Alfen app when resuming is off).`,
      `En pause par un courant maximal de la borne à 0 A ; ${amps} A avant la pause, la valeur qu'une reprise réécrit (à remettre dans l'application Alfen quand la reprise est désactivée).`,
    ),
  pausedUnknown: both(
    'Paused by a maximum station current of 0 A; its value before the pause is unknown: set it back in the Alfen app (a resume from Gladys is refused).',
    "En pause par un courant maximal de la borne à 0 A ; sa valeur avant la pause est inconnue : remettez-la dans l'application Alfen (une reprise depuis Gladys est refusée).",
  ),
  noId: both(
    'The charger answered without a valid identity: it cannot be added.',
    'La borne a répondu sans identité valable : elle ne peut pas être ajoutée.',
  ),
  otherCharger: (names) =>
    both(
      `Not read any more: ${names} (another charger answers at this address, or it was removed).`,
      `Plus lue : ${names} (une autre borne répond à cette adresse, ou elle a été retirée).`,
    ),
  held: (held) =>
    both(
      `Energy index held back: ${held.direction === 'down' ? 'a drop' : 'a jump'} from ${kwh(held.from)} to ${kwh(held.to)} kWh, never counted without you ("Accept the held index", two clicks).`,
      `Index d'énergie retenu : ${held.direction === 'down' ? 'une baisse' : 'un saut'} de ${kwh(held.from)} à ${kwh(held.to)} kWh, jamais compté sans vous (« Accepter l'index retenu », deux clics).`,
    ),
  test: {
    notDue: (wait) =>
      both(
        `The charger is read at most once per interval: next read in ${wait.en}.`,
        `La borne est lue au plus une fois par intervalle : prochaine lecture dans ${wait.fr}.`,
      ),
  },
  accept: {
    nothing: both('No energy index is held back.', "Aucun index d'énergie n'est retenu."),
    confirm: (held) =>
      both(
        `Held: ${held.direction === 'down' ? 'a drop' : 'a jump'} from ${kwh(held.from)} to ${kwh(held.to)} kWh (${kwh(Math.max(0, held.to - held.from))} kWh would be counted). Click again within 60 s to accept exactly this.`,
        `Retenu : ${held.direction === 'down' ? 'une baisse' : 'un saut'} de ${kwh(held.from)} à ${kwh(held.to)} kWh (${kwh(Math.max(0, held.to - held.from))} kWh seraient comptés). Cliquez de nouveau dans les 60 s pour accepter exactement cela.`,
      ),
    done: (taken) =>
      both(
        `Accepted: ${taken.direction === 'down' ? 'the drop' : 'the jump'} from ${kwh(taken.from)} to ${kwh(taken.to)} kWh; the index goes on from there.`,
        `Accepté : ${taken.direction === 'down' ? 'la baisse' : 'le saut'} de ${kwh(taken.from)} à ${kwh(taken.to)} kWh ; l'index repart de là.`,
      ),
  },
  trust: {
    confirm: (fingerprint) =>
      both(
        `Certificate refused: ${fingerprint}. Compare it, then click again within 60 s to trust exactly this one.`,
        `Certificat refusé : ${fingerprint}. Comparez-le, puis cliquez de nouveau dans les 60 s pour approuver exactement celui-ci.`,
      ),
    nothing: both(
      'No new certificate was refused: nothing to trust.',
      "Aucun nouveau certificat n'a été refusé : rien à approuver.",
    ),
    done: (fingerprint) =>
      both(
        `The certificate ${shortFingerprint(fingerprint)}… is trusted from now on.`,
        `Le certificat ${shortFingerprint(fingerprint)}… est désormais approuvé.`,
      ),
  },
  badge: {
    held: (held) =>
      both(
        `Energy index held: ${kwh(held.from)} → ${kwh(held.to)} kWh`,
        `Index d'énergie retenu : ${kwh(held.from)} → ${kwh(held.to)} kWh`,
      ),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Resuming and the charging current are disabled: turn on "Allow resuming and the charging current" in the configuration of the integration ("Pause charging" stays available).',
    "La reprise et le courant de charge sont désactivés : activez « Autoriser la reprise et le courant de charge » dans la configuration de l'intégration (« Mettre la charge en pause » reste disponible).",
  ),
  unknownCharger: both(
    'This charger is not read by the integration (address changed, another charger, or not answering yet).',
    "Cette borne n'est pas lue par l'intégration (adresse changée, autre borne, ou pas encore de réponse).",
  ),
  otherCharger: both(
    'Another charger answers at the address: command not sent.',
    "Une autre borne répond à l'adresse : commande non envoyée.",
  ),
  notReadYet: both(
    'The charger was not read since the start: only "Pause charging" is accepted until then. Not sent.',
    "La borne n'a pas encore été lue depuis le démarrage : seule « Mettre la charge en pause » est acceptée d'ici là. Non envoyée.",
  ),
  noAddress: both(
    'No valid address or no password in the configuration: not sent.',
    'Aucune adresse valable ou aucun mot de passe dans la configuration : non envoyée.',
  ),
  certificate: both(
    'The certificate of the charger changed: nothing is sent to it ("Trust the new certificate" in the configuration).',
    'Le certificat de la borne a changé : rien ne lui est envoyé (« Faire confiance au nouveau certificat » dans la configuration).',
  ),
  configChanged: both(
    'The configuration changed during the command: not sent, try again.',
    'La configuration a changé pendant la commande : non envoyée, réessayez.',
  ),
  storage: both(
    'The certificate of the charger could not be kept in /data: the password is not sent. Not sent.',
    "Le certificat de la borne n'a pas pu être gardé dans /data : le mot de passe n'est pas envoyé. Non envoyée.",
  ),
  noResumeValue: both(
    'The maximum station current before the pause is unknown (paused outside Gladys?): set it back in the Alfen app. Not sent.',
    "Le courant maximal de la borne avant la pause est inconnu (pause faite hors de Gladys ?) : remettez-le dans l'application Alfen. Non envoyée.",
  ),
  sessionLost: both(
    'The charger closed the session before the command (another app logged in?): not sent.',
    'La borne a fermé la session avant la commande (une autre application connectée ?) : non envoyée.',
  ),
  credentialsRefused: both(
    'The charger refused the user name or the password: not sent.',
    "La borne a refusé le nom d'utilisateur ou le mot de passe : non envoyée.",
  ),
  rateLimitedNotSent: (wait) =>
    both(
      `The charger asks to slow down (HTTP 429): not sent, pause of ${wait.en} ("Pause charging" stays available).`,
      `La borne demande de ralentir (HTTP 429) : non envoyée, pause de ${wait.fr} (« Mettre la charge en pause » reste disponible).`,
    ),
  badButton: both('A button only accepts the value 1.', "Un bouton n'accepte que la valeur 1."),
  badCurrent: both(
    'The charging current must be a whole number of amperes.',
    "Le courant de charge doit être un nombre entier d'ampères.",
  ),
  outOfBounds: (min, max) =>
    both(
      `The charging current must be between ${min} and ${max} A for this charger: not sent.`,
      `Le courant de charge doit être entre ${min} et ${max} A pour cette borne : non envoyé.`,
    ),
  paused: (wait) =>
    both(
      `The charger asked to slow down: commands paused for ${wait.en} ("Pause charging" stays available).`,
      `La borne a demandé de ralentir : commandes en pause pendant ${wait.fr} (« Mettre la charge en pause » reste disponible).`,
    ),
  serverPaused: (wait) =>
    both(
      `The charger answered with a server error: commands paused for ${wait.en} ("Pause charging" stays available).`,
      `La borne a répondu par une erreur serveur : commandes en pause pendant ${wait.fr} (« Mettre la charge en pause » reste disponible).`,
    ),
  blocked: both(
    'The charger refused the credentials: commands are not sent until they are fixed ("Pause charging" is still tried).',
    "La borne a refusé les identifiants : les commandes ne sont pas envoyées tant qu'ils ne sont pas corrigés (« Mettre la charge en pause » est quand même tentée).",
  ),
  blockedPause: (wait) =>
    both(
      `The charger refused the credentials less than 5 minutes ago: a refused password is never sent again in a loop, try again in ${wait.en}. Not sent.`,
      `La borne a refusé les identifiants il y a moins de 5 minutes : un mot de passe refusé n'est jamais renvoyé en boucle, réessayez dans ${wait.fr}. Non envoyée.`,
    ),
  stillRunning: both(
    'Another command of this charger is still running: not sent ("Pause charging" stays available).',
    'Une autre commande de cette borne est encore en cours : non envoyée (« Mettre la charge en pause » reste disponible).',
  ),
  pauseMeanwhile: both(
    'A pause of this charger arrived meanwhile: this command is not sent.',
    "Une pause de cette borne est arrivée entre-temps : cette commande n'est pas envoyée.",
  ),
  tooOften: (wait) =>
    both(
      `The charge was resumed or its current changed less than a minute ago: try again in ${wait.en} ("Pause charging" stays available). Not sent.`,
      `La charge a été reprise ou son courant changé il y a moins d'une minute : réessayez dans ${wait.fr} (« Mettre la charge en pause » reste disponible). Non envoyé.`,
    ),
  tooSlow: both(
    'The charger answered too slowly to send the command in time: not sent.',
    'La borne a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the charger could not be read just before (${reason}): command not sent.`,
      `L'état de la borne n'a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  missing: both(
    'The charger did not give the state this command needs: not sent.',
    "La borne n'a pas donné l'état dont cette commande a besoin : non envoyée.",
  ),
  noVehicle: both(
    'No vehicle is plugged in: the charge is not resumed. Not sent.',
    "Aucun véhicule n'est branché : la charge n'est pas reprise. Non envoyée.",
  ),
  fault: (state) =>
    both(
      `The charger reports "${state.en}": the charge is not resumed. Not sent.`,
      `La borne signale « ${state.fr} » : la charge n'est pas reprise. Non envoyée.`,
    ),
  notSent: (reason) =>
    both(
      `The charger could not be reached (${reason}): command not sent.`,
      `La borne n'a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The charger refused the command (${reason}).`,
      `La borne a refusé la commande (${reason}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the charger in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l'état de la borne dans quelques secondes.`,
    ),
};

/** The one-line summary of the charger: "Alfen Eve 3456: Charging, 7200 W, 16 A set". */
export function summaryOf({ name, power, current }, stateText) {
  const en = [stateText.en];
  const fr = [stateText.fr];
  if (power !== undefined) {
    en.push(`${power} W`);
    fr.push(`${power} W`);
  }
  if (current !== undefined) {
    en.push(`${current} A set`);
    fr.push(`${current} A réglés`);
  }
  return both(`${name}: ${en.join(', ')}.`, `${name} : ${fr.join(', ')}.`);
}
