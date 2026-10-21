# Alfen Eve pour Gladys

Affiche votre borne de recharge **Alfen Eve** (Single S-line, Single
Pro-line, Double Pro-line) dans Gladys par son **API HTTPS locale** : sans
cloud, sans compte, directement sur votre réseau.

> **Jamais testé avec une vraie borne.** Sans lien avec Alfen. L'API locale
> d'Alfen n'est pas documentée : l'intégration lui parle comme l'intégration
> alfen_wallbox de Home Assistant. Alfen peut la changer lors d'une mise à
> jour de la borne.

## Ce que vous obtenez

Un appareil par borne (la prise 1 d'une Eve Double dans cette version), avec :

| Fonctionnalité                             | Contenu                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------- |
| État                                       | Aucun véhicule, branché sans charge, charge en pause, en charge, erreur         |
| Statut de la borne                         | Le statut donné par la borne, en texte (« Charging Normal (11) »)               |
| Connecteur                                 | Disponible, occupé, en défaut ou indisponible (catégorie « borne de recharge ») |
| État de charge                             | En charge, véhicule connecté, en pause par la borne, inactif                    |
| Véhicule branché, Charge en pause, Erreur  | Oui / non                                                                       |
| Puissance                                  | En W                                                                            |
| Courant L1 / L2 / L3, Tension L1 / L2 / L3 | En A et en V                                                                    |
| Courant maximal de la borne                | En A : la limite de l'installation ; 0 A quand la charge est en pause           |
| Courant de charge réglé                    | En A, le courant maximal de la prise 1                                          |
| Index d'énergie                            | En kWh, le compteur de la prise : un index, protégé (voir plus bas)             |
| Température                                | En °C                                                                           |
| Mettre la charge en pause                  | Bouton, toujours disponible                                                     |
| Reprendre la charge                        | Bouton (seulement si autorisé)                                                  |
| Régler le courant de charge                | Liste de 6 A au plafond (seulement si autorisé)                                 |

Lecture toutes les 60 secondes par défaut (de 30 s à 1 h, réglable).

## Installation

1. Donnez à la borne une **adresse IP fixe** dans votre box.
2. Il vous faut le **mot de passe de la borne** : celui que demande
   l'application Alfen (« MyEve » ou
   « Eve Connect »). Le nom d'utilisateur est en général `admin`.
3. Installez l'intégration depuis le store de Gladys. Dans sa configuration,
   saisissez l'**adresse IP de la borne** et son **mot de passe**. Un nom et
   un mot de passe collés dans l'adresse (`admin:…@`) font ignorer l'adresse,
   et ne sont jamais réaffichés : utilisez les champs dédiés.
4. Enregistrez, puis ajoutez la borne depuis l'onglet **Découverte**.

Le mot de passe est **gardé par Gladys dans sa base, jamais réaffiché**, et
envoyé seulement à la borne, en HTTPS. Il n'est jamais écrit dans les
journaux, ni dans `/data`, ni dans un état.

### Une seule session à la fois

La borne n'accepte **qu'une session à la fois**. L'intégration ne garde
donc jamais la borne : à chaque lecture, elle ouvre une connexion courte, se
connecte, lit, **se déconnecte** et ferme la connexion (quelques secondes).
L'application Alfen (MyEve, Eve Connect) peut se connecter entre deux lectures.
Pendant qu'elle est connectée, la borne peut refuser la connexion de Gladys :
l'état le dit (« la borne a fermé la session » ou « identifiants refusés »),
et les essais suivants sont espacés. Gladys n'ouvre jamais deux sessions à la
fois : une commande prend la place d'une lecture en cours, une pause prend la
place de tout.

### Certificat épinglé

La borne présente un certificat **auto-signé** : aucune autorité ne peut le
garantir. À la **première connexion**, l'intégration retient son empreinte
SHA-256 (dans `/data`) et la compare ensuite à chaque connexion, **avant
d'envoyer quoi que ce soit**, le mot de passe compris. Si le certificat
change (borne remplacée, mise à jour, ou autre appareil à l'adresse), rien
n'est envoyé : l'état affiche le début de la nouvelle empreinte. Si c'est
bien votre borne, cliquez sur **« Faire confiance au nouveau certificat »**,
**en deux clics** : le premier montre l'empreinte entière (comparez-la), le
second dans les 60 secondes épingle exactement celle-là, puis la borne est
lue ; si une autre empreinte a été vue entre-temps, elle est montrée de
nouveau. La toute première connexion fait confiance au certificat présenté :
faites-la sur votre réseau de confiance. Si `/data` ne peut pas être écrit,
la première épingle n'est pas gardée et le mot de passe n'est pas envoyé
(l'état le dit). La connexion exige TLS 1.2 au moins ; la liste des
algorithmes est élargie (niveau de sécurité 1, comme l'intégration Home
Assistant) pour les bornes anciennes : c'est l'épingle, vérifiée avant tout
envoi, qui garantit la borne.

Le bouton **Tester la connexion** lit la borne une fois si l'intervalle
depuis la dernière lecture est passé (jamais plus souvent : ni par ce bouton,
ni par l'onglet Découverte, ni par une reconnexion de Gladys, ni par un
enregistrement de la configuration, ni par un redémarrage).

## Index d'énergie

Le compteur de la prise est un **index** : Gladys en tire la consommation et
le coût, et compte chaque hausse en entier. L'intégration le protège comme
l'intégration P1 Monitor :

- jamais 0 ; une **baisse** ou un **saut** improbable (plus de 25 kW en
  moyenne depuis la dernière valeur, une prise en donne 22 au plus) est
  **retenu** : la dernière valeur acceptée est renvoyée, l'état de
  l'intégration et le badge de l'appareil montrent les kWh en attente, et le
  journal le dit ; la retenue est gardée dans `/data`, même après un
  redémarrage ;
- elle n'est jamais confirmée par la répétition ni par le temps : seule
  l'action **« Accepter l'index retenu »** de la configuration la prend, **en
  deux clics**. Le premier clic ne prend rien : il montre la valeur retenue
  (baisse ou saut, de → à, kWh). Un second clic dans les 60 secondes prend
  exactement cela — la valeur montrée, plus ce que la borne a pu charger
  depuis — et répond par ce qui est compté ; si la valeur a changé
  entre-temps, elle est montrée de nouveau. Enregistrer la configuration ou
  une reconnexion n'accepte jamais rien ;
- une borne ajoutée de nouveau repart d'une garde neuve.

La borne est en général derrière votre compteur principal : dans les réglages
d'énergie de Gladys, rangez-la sous ce compteur pour qu'elle ne soit pas
comptée deux fois.

## Commandes

**« Mettre la charge en pause »** est toujours disponible, sans option. La
borne Alfen n'a pas de commande de pause : comme l'intégration Home
Assistant, Gladys met le **courant maximal de la borne à 0 A** (`2062_0`).
La pause n'est **jamais retenue** : ni par une autre commande en cours (elle
prend sa place ; une reprise ou un courant pas encore envoyé est abandonné),
ni par la minute entre deux changements, ni par une pause 429 ou 5xx (une
seule session), ni par l'absence de lecture (elle n'en a pas besoin), ni
juste après un redémarrage (l'identité de la borne est gardée dans `/data`).
Quand la borne a refusé les identifiants, la pause tente quand même une
connexion, **au plus une toutes les 5 minutes** : un mot de passe refusé
n'est jamais renvoyé en boucle (par une scène par exemple). Une pause qui
passe lève le blocage et les lectures reprennent ; une pause refusée
n'allonge pas l'attente des lectures.

Avant d'écrire, la pause relit le courant maximal de la borne quand le temps
le permet : elle **garde dans `/data` la valeur d'avant la pause** (celle
qu'une reprise réécrira), et n'écrit rien si la borne est déjà en pause (pas
de lecture de suivi alors). Si cette lecture échoue, la pause est écrite
quand même.

Quand une reprise est restée sans confirmation, elle peut encore atteindre la
borne plus tard : une pause envoyée dans les 90 secondes qui suivent est
surveillée, et renvoyée (deux fois au plus, même si un renvoi échoue) si une
lecture montre la charge reprise alors qu'aucune autre reprise n'est partie
depuis Gladys. **Attention** : une reprise faite dans ces 90 secondes depuis
l'application Alfen est donc annulée elle aussi ; refaites-la
après.

**Une pause reste sur la borne jusqu'à une reprise** : le courant maximal de
la borne reste à 0 A. Avec l'option ci-dessous désactivée (par défaut), seule
l'application Alfen (MyEve, Eve Connect) remet ce courant : une pause oubliée
(par une scène, le chat IA) peut empêcher la charge suivante et laisser la
voiture non chargée. **La valeur à remettre** est celle d'avant la pause :
l'état de l'intégration l'affiche pendant la pause (« … A avant la pause »).
Que l'application du propriétaire puisse modifier ce réglage n'a pas été
vérifié : il faut parfois l'outil de l'installateur.

**« Reprendre la charge »** et **« Régler le courant de charge »** refusent
toute commande tant que **Autoriser la reprise et le courant de charge** est
désactivé (par défaut). Activé :

- **Reprendre** remet le courant maximal de la borne à **exactement** la
  valeur gardée au moment de la pause (la limite de votre installation),
  jamais plafonnée ni devinée : sans valeur gardée (pause faite hors de
  Gladys), la reprise est **refusée** ; refusée aussi **sans véhicule
  branché**, ou sur une erreur ou un état inconnu.
- **Courant de charge** (`2129_0`, la prise 1) : de 6 A au **plafond** : le
  plus bas du « Plafond du courant de charge » de la configuration (16 A par
  défaut ; il ne s'applique qu'à ce courant) et du courant maximal de la
  borne, revérifié juste avant l'envoi. Régler le courant pendant une pause
  ne reprend pas la charge.
- **Un changement par minute au plus** (reprise ou courant) : pas de
  régulation fine depuis Gladys. Ce sont des réglages de la borne : ne les
  changez pas sans cesse.

Ce sont des **boutons** et une **liste**, jamais des interrupteurs : un
« éteins tout » (depuis Gladys, Google Home, Alexa ou HomeKit) ne les atteint
jamais. Une scène peut les déclencher, seulement par une action explicite.
Notez que le chat IA de Gladys (MCP) peut créer et lancer une telle scène :
tant que les commandes sont autorisées, il peut reprendre la charge ou
changer le courant.

Chaque commande ouvre sa propre session : connexion, certificat vérifié,
**identité de la borne relue** (une autre borne à l'adresse refuse la
commande ; une identité illisible n'est pas une autre borne), connexion,
puis, pour une reprise ou un courant, **lecture de la borne** sur laquelle
seule elle décide. L'option et l'échéance sont revérifiées juste avant
l'envoi. Une commande sans effet (déjà le cas) n'est pas envoyée. Une
commande qui ne peut pas partir dans les 3,5 secondes (connexion comprise)
est refusée sans être envoyée. Une commande acceptée par la borne n'est
confirmée que par une lecture montrant la valeur demandée, faite 5 puis
20 secondes plus tard. Quand la borne ne répond pas (silence, erreur 5xx),
Gladys affiche « Commande envoyée, sans confirmation ».

## Erreurs et limites

- **Borne injoignable** : seuls le connecteur (« indisponible ») et l'état
  (« Borne injoignable ») changent ; les autres valeurs gardent la dernière.
  Nouvel essai après 30 s, 1, 2, puis 5 minutes, jamais plus vite que
  l'intervalle.
- **Identifiants refusés** : l'état demande de les vérifier. Nouveaux essais
  après 15 minutes, 1 heure, puis toutes les 6 heures, jamais plus tôt (gardé
  dans `/data` après un redémarrage) ; enregistrer de nouveaux identifiants
  réessaie aussitôt.
- **429 (trop de requêtes)** ou **5xx** : une pause (de 1 minute à 6 heures
  pour un 429) pour les lectures et les commandes sauf la pause de la charge,
  jamais plus courte que l'intervalle, gardée dans `/data`. Une erreur sur la
  température seule n'arrête pas le reste.
- Une seule borne par intégration, la prise 1 seulement. Ni les phases, ni la
  charge solaire, ni l'autorisation RFID, ni un redémarrage de la borne ne se
  commandent depuis Gladys dans cette version. Pas de Bluetooth.
- Si votre borne est aussi pilotée par OCPP ou par la répartition de charge
  d'un autre système, les deux peuvent se contredire : n'en commandez qu'un.
- Les journaux ne contiennent jamais le texte des réponses de la borne, ni le
  mot de passe, ni le jeton de session.

## Crédits

Portage de [alfen_wallbox](https://github.com/leeyuentuen/alfen_wallbox)
(leeyuentuen, MIT), l'intégration Alfen de Home Assistant. Garde de l'index
reprise de l'intégration P1 Monitor. Licence Apache-2.0.
