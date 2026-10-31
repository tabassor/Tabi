# Tabi 旅

Carnet de voyage partagé de Felipe et Lucie : journées sur une carte, lieux tamponnés, réservations et billets, photos, notes, suggestions de Claude.

- **Appli** : https://tabassor.github.io/Tabi/ (GitHub Pages, branche `main`, racine)
- **Données** : dossier Google Drive « Tabi - Japon » (`1PNvIMPKu0ciOo_QkDu8FmYB0UQ_MKcvG`), jamais dans ce dépôt
- **Carte** : MapLibre GL 4.7.1 (copie locale dans `vendor/`) + fond OpenFreeMap © OpenMapTiles © contributeurs OpenStreetMap
- **Connexion** : Google Identity Services, accès Drive. L'appli Google reste en mode « Test » (utilisateurs autorisés : Felipe, Lucie).

## Dossier Drive

```
Tabi - Japon/
  README.md        ← contrat de données pour Claude, recopié depuis drive-readme.md
  Récap.md         ← ancien récap (lecture seule) ; le récap vit dans data/recap_*.json
  data/            ← un fichier JSON par élément : <type>_<id>.json
  photos/          ← images envoyées depuis l'appli
  billets/         ← billets PDF ou images
```

**Le format des éléments et les règles pour Claude sont dans [`drive-readme.md`](drive-readme.md).** C'est la référence : à chaque synchronisation, l'appli compare sa version (`<!-- tabi-readme vN -->`, première ligne) à celle du `README.md` du Drive et le remplace si elle est plus récente. Pour changer le format, modifier `drive-readme.md` et incrémenter `vN`.

Champs techniques non décrits là-bas (gérés par l'appli uniquement) :

| type | champs |
|---|---|
| `secret` (id `navitime`) | `rapidApiKey` (clé RapidAPI de NAVITIME Route totalnavi), `monthlyQuota` |
| `usage` (id `navusage`) | `month` (AAAA-MM), `n` : requêtes NAVITIME du mois |
| `config` (id `config`) | `mapsEmbedKey` : clé Google (Maps Embed API et Maps JavaScript API, restreinte au site Tabi), lue après connexion ; jamais dans le code |
| `leg` (id `leg_<départ>_<arrivée>`, clé = id du lieu ou `h` + id de la réservation d'hôtel) | `from`, `to`, `mode` (walk, transit, taxi ; absent = auto), `style` (fonctionnel, promenade), `via`, `route`, `near`, `lastMile`, `nav`, `pick`, `pois` |
| `place` | en plus : `googlePlaceId`, `pin` (point GPS brut de « Je suis ici » : `lat`, `lng`, `acc` en m, `at` ISO), `toIdentify`, `identifiedAt` |

### Règles de synchronisation

- **Doublons d'un même élément** (même `id`, même `type`, deux fichiers) : l'appli garde le plus récent (`updatedAt`, puis date de modification Drive) et ignore l'autre, sans le relire tant qu'il ne change pas. C'est ce qui permet à Claude, qui ne peut ni modifier ni supprimer un fichier Drive, de corriger un élément en déposant une nouvelle version.
- **Pierre tombale** : un élément avec `deleted: true` est masqué partout. Dans l'appli, retirer un point du récap utilise ce mécanisme.
- **Même `id`, types différents** : le lieu garde l'id, l'autre élément est renommé `<type>-<id>`.
- **Billets** : téléchargés sur l'appareil après chaque synchronisation (IndexedDB, clé `c:<id>`), pour être présentés sans réseau.

Le mode auto choisit la marche si le trajet à pied dure au plus `trip.walkMax` minutes (20 par défaut), sinon les transports. Les itinéraires en transports en commun viennent de Google Maps (l'API Google ne les fournit pas pour le Japon). Tracés à pied : Valhalla (FOSSGIS), OSRM en secours ; entrées de métro et lieux : Overpass (OpenStreetMap).

## Fonctions ajoutées (v20)

- **À suivre** (onglet Résas) : échéances, points en attente, sommes à régler sur place par jour, heures d'arrivée aux hôtels ; pastille sur l'onglet (tâches ouvertes + échéances à 14 jours). Rappel des sommes du jour dans la journée et l'itinéraire.
- **Carte adresse** : nom et adresse en japonais en grand, téléphone, phrase « この住所までお願いします。 », depuis un lieu ou une réservation.
- **Billet en plein écran** : image en grand sur fond blanc, numéro de réservation, écran maintenu allumé (Wake Lock), disponible hors ligne. Les PDF s'ouvrent dans le lecteur du téléphone.
- **Photos rattachées aux étapes** : à l'envoi, lecture de l'heure et de la position GPS (EXIF, avant réduction) ; une photo du journal prise à moins de 250 m d'une étape (position non estimée) y est rattachée d'office. Dans une photo : choix du jour et de l'étape, suggestion par position ou par l'heure du tampon. Rendez-vous et hôtels sans lieu acceptent aussi des photos.
- **Nouvel An** : du 29/12 au 3/01, les musées, jardins, boutiques, restaurants et activités non réservés portent une alerte « Nouvel An ».
- **Bagages** : type de réservation `bagages` (takkyūbin).
- **Récap** dans l'onglet Claude (éléments `recap`).

## Identité graphique (v21)

Base « ligne de train » (signalétique ferroviaire japonaise) et touche « washi et hanko » :

- **Journée** : les étapes sont les arrêts d'une ligne à la couleur du jour (numéros 01, 02…), les trajets en font partie ; le tampon de visite est un sceau vermillon 済 avec l'heure, posé avec une animation et une courte vibration (Android).
- **Navigation** : barre d'onglets flottante, pastille qui glisse sous l'onglet actif, compteurs rouges ; glissement latéral entre jours et fondu entre onglets (API View Transitions, sinon apparition en cascade).
- **Panneaux** : poignée, entrée à ressort, fermeture animée ou d'un geste vers le bas sur l'en-tête.
- **Souvenirs** : papier washi, titres en Shippori Mincho, sceau 旅.
- **Chargement** : silhouettes grisées. Toutes les animations sont coupées si le téléphone demande moins de mouvements.

Icônes de catégorie : tracés Tabler Icons (MIT) embarqués dans `icons.js`, ♨ pour les onsen, torii pour « Temple / sanctuaire » ; affichées dans les étiquettes de catégorie et sur les repères d'idées et de suggestions de la carte.

Jetons de couleur en tête de la couche « refonte v21 » de `style.css` (`--stamp` = accent sarcelle, `--hanko` = vermillon, `--washi`).

## Développement

Fichiers statiques, sans compilation. Tester en local : `python3 -m http.server 8000` puis http://localhost:8000 (origine autorisée dans Google Cloud).
