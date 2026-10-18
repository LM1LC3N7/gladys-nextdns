# NextDNS

Vos profils NextDNS dans Gladys, par l'API officielle de NextDNS et la clé
d'API de votre compte. Chaque profil devient un appareil Gladys :

- **Queries (24 h)** et **Blocked queries (24 h)** : les requêtes DNS et les
  requêtes bloquées des dernières 24 heures ;
- **Blocked queries (%)** : la part bloquée ;
- **Encrypted queries (%)** : la part des requêtes arrivées par un transport
  DNS chiffré (DNS-over-HTTPS, DNS-over-TLS, DNS-over-QUIC…) ;
- **Devices seen (24 h)** : les appareils identifiés qui ont fait au moins une
  requête (les requêtes non identifiées ne comptent pas) ;
- l'état de chaque **filtre** (1 activé, 0 désactivé) : protections de
  sécurité, bloqueur de traceurs déguisés, recherche sécurisée, mode restreint
  YouTube, blocage des contournements, catégories (porno, jeux d'argent,
  rencontres, piratage, réseaux sociaux, jeux en ligne, streaming vidéo) et
  services bloqués de votre profil (TikTok, Fortnite…) ;
- la liste **Filter command**, pour activer ou désactiver un filtre (désactivée
  par défaut, voir Commandes).

> **Cette intégration n'a jamais été testée sur un vrai compte NextDNS.**
> Cette première version a été écrite à partir de la documentation officielle
> de l'API NextDNS et de la bibliothèque Python nextdns 5.1.0, et testée
> seulement contre un faux NextDNS. Dites sur le forum de Gladys ce qui marche
> et ce qui ne marche pas.

Intégration non officielle, sans lien avec NextDNS.

## Configuration

- **Clé d'API** : sur [my.nextdns.io](https://my.nextdns.io/account),
  **Account**, section **API**, en bas de la page. Gardée par Gladys dans sa
  base, jamais réaffichée, envoyée seulement à `api.nextdns.io`, dans l'en-tête
  `X-Api-Key` (jamais dans une adresse, jamais dans un journal, jamais dans le
  volume `/data`). Attention : la clé donne accès à tout le compte NextDNS
  (NextDNS ne propose pas de clé en lecture seule).
- **Profils** : les identifiants des profils à suivre (les 6 caractères de
  `my.nextdns.io/<id>`), séparés par des virgules ; vide, tous les profils du
  compte, 10 au plus.
- **Rafraîchissement** : toutes les 5 minutes (par défaut) à toutes les
  heures. Chaque lecture fait 4 requêtes par profil, l'une après l'autre.
- **Autoriser les commandes de filtres** et **Autoriser la désactivation des
  protections** : désactivées par défaut (voir Commandes).

Ouvrez ensuite l'onglet **Découverte** et créez les profils à suivre.

Les chiffres de NextDNS ne viennent que si les journaux (**Logs**) sont
activés dans le profil : sinon les requêtes restent à 0.

## Commandes

- Par défaut Gladys ne fait que lire. Un filtre n'est **jamais un
  interrupteur** : Gladys donne chaque interrupteur aux assistants vocaux
  (Google Home, Alexa, HomeKit), à MCP et aux actions de scène « éteindre »,
  donc « éteins tout » couperait vos protections. Chaque filtre est une
  lecture, et les commandes passent par la liste **Filter command** du profil
  (tableau de bord ou action de scène « Contrôler un appareil »).
- **Turn on: …** (activer un filtre) demande **Autoriser les commandes de
  filtres**.
- **Turn off: …** (désactiver une protection de sécurité, le bloqueur de
  traceurs ou un filtre de contrôle parental) demande en plus **Autoriser la
  désactivation des protections**. Sans elle, Gladys refuse et n'envoie rien.
- Juste avant d'agir, Gladys relit le profil chez NextDNS et décide sur cette
  lecture seulement : un filtre dont l'état est inconnu est refusé ; un filtre
  déjà dans l'état demandé ne déclenche aucun envoi. Quand la commande ne peut
  pas être vérifiée en 3,5 s, rien n'est envoyé et Gladys affiche un échec
  (jamais d'action après un échec affiché). Une commande partie sans réponse
  de NextDNS à temps s'affiche en échec avec « envoyée, pas encore
  confirmée » (jamais « non envoyée ») ; l'état du filtre suit la réponse, et
  le profil est relu quelques secondes après.
- Seules les options de la liste du profil sont acceptées. Les commandes d'un
  profil passent une par une (la suivante attend la réponse de la
  précédente). La liste revient sur « — » 1,5 s après chaque commande.
- Décocher une option prend effet tout de suite, même si une lecture est en
  cours.
- Les services bloqués sont ceux de votre profil : un service ajouté plus tard
  dans NextDNS apparaît dans la Découverte ; appuyez sur **Mettre à jour**
  pour l'ajouter à l'appareil. Un service retiré garde sa fonctionnalité (à
  0), pour ne jamais casser l'historique.
- Le **temps de récréation** (Recreation Time) du contrôle parental n'est pas
  pris en compte : l'état affiché est le réglage du filtre, même pendant une
  récréation.

## Problèmes de connexion

- **Clé refusée** (HTTP 401, ou 403 de l'API elle-même) : Gladys ne réessaie
  pas seul, même après un redémarrage. Copiez la clé, collez-la et enregistrez,
  ou appuyez sur **Tester la connexion**.
- **NextDNS surchargé** (HTTP 429, reçu par n'importe quelle requête) ou
  **erreur serveur** (HTTP 5xx sur la liste des profils) : toutes les requêtes
  s'arrêtent, au moins l'intervalle choisi (429 : de 1 minute à 6 heures, ce
  que demande NextDNS), même après un redémarrage ; enregistrer la
  configuration ou appuyer sur **Tester la connexion** lève la pause.
- **NextDNS injoignable** : nouvel essai à l'intervalle choisi, puis de plus en
  plus espacé jusqu'à une heure. Les appareils apparaissent injoignables
  entre-temps.
- Une requête secondaire d'un profil qui échoue (part chiffrée, appareils…) ne
  bloque jamais les autres chiffres : l'état de la connexion le signale.

## Limites

- Un seul compte NextDNS par intégration, 10 profils au plus (les profils
  déjà créés passent d'abord ; l'état de la connexion dit combien sont
  écartés), 60 services bloqués par profil.
- Gladys accepte 300 états par minute : la première publication de nombreux
  profils (jusqu'à 10) peut prendre plusieurs tours de lecture.
- **Devices seen** compte au plus 500 appareils.
- Les parts en % n'ont pas d'unité dans Gladys (le cœur n'a pas de catégorie
  « part de requêtes ») : 75 veut dire 75 %.
- Les listes de blocage (blocklists), la liste d'autorisation, la liste de
  refus et les réglages (journaux, cache…) ne sont pas suivis.
