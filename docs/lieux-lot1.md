# Bibliothèque de lieux et cartes postales — lot 1

Validé avec Felipe le 12/11/2026. À livrer et figer vers le 10/12/2026, pour un essai sur les vraies données avant le départ au Japon (18/12). Le lot 2 (après le voyage) est rappelé en fin de document.

## 1. Principe

Un **lieu** est un endroit qui vaut qu'on s'y arrête : point de vue, façade, ruelle, ambiance, temple, café… Il existe en dehors des journées du voyage. Une **visite** est un passage à ce lieu, à une date donnée. Une **étape** (élément `place` existant) appartient à une journée et peut pointer vers un lieu.

Rien n'est migré dans ce lot : les étapes existantes restent telles quelles ; le lien étape → lieu est facultatif (`place.lieuId`).

## 2. Modèle de données (dossier Drive `data/`)

### `lieu_<code>.json`

| champ | rôle |
|---|---|
| `id` = `code` | identifiant permanent, `TB-` + 6 caractères parmi `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (sans 0/O, 1/I/L). Jamais réutilisé, sans lien avec le nom ni la position. |
| `type` | `lieu` |
| `name`, `nameJa`, `nameKana` | nom français ; nom local ; lecture (rōmaji ou kana) |
| `kind` | catégorie (celles des étapes + `facade`, `ambiance`, `photo`) |
| `lat`, `lng`, `coordSource` | position du point où se tenir |
| `heading` | direction du regard en degrés (0 = nord), facultatif |
| `city`, `country`, `address`, `addressJa` | localisation |
| `seasons` | meilleures saisons : `printemps`, `ete`, `automne`, `hiver` |
| `moments` | meilleurs moments : `matin`, `journee`, `doree` (heure dorée), `soir`, `nuit` |
| `tags` | étiquettes d'ambiance libres |
| `detour` | `passage` (en passant), `detour` (vaut 15 min de détour), `expres` (à faire exprès) |
| `access` | comment y accéder (texte) |
| `note` | note libre |
| `verdict` | avis global imposé (`super`, `bien`, `bof`) ; vide = déduit de la dernière visite |
| `private` | lieu privé : jamais dans une carte postale, un QR code ou un export |
| `source` | `{ url, text, mediaId, at }` : d'où vient l'idée, avec une copie (texte et capture d'écran) |
| `refPhoto` | id de la photo de référence (`media`) |
| `by`, `createdAt` | auteur (prénom, saisi librement : Felipe, Lucie, Anaïs…) et date |
| `mergedInto` | code du lieu qui l'a absorbé (fusion) ; le lieu est alors masqué, mais son code reste résolu |

Statut : **repéré** tant qu'il n'a aucune visite, **vécu** dès la première visite (déduit, non stocké).

### `visite_<id>.json`

| champ | rôle |
|---|---|
| `lieuId` | code du lieu |
| `n` | numéro de visite (1, 2, …) : le QR code d'une carte postale porte `<code>/<n>` |
| `date`, `time` | date et heure locales |
| `season` | déduite de la date (mars–mai printemps, juin–août été, sept.–nov. automne, déc.–fév. hiver), modifiable |
| `verdict` | `super`, `bien`, `bof` |
| `phrase` | la petite phrase (souvenir, mot) reprise sur la carte postale |
| `by` | auteur |
| `photo` | id de la photo choisie pour la carte postale |
| `printedAt` | date de la dernière carte postale générée (le numéro `n` ne change plus ensuite) |
| `printedFormat` | format de cette dernière carte : `L`, `2L`, `10x15` ou `13x18` |

Photos : éléments `media` existants, avec `lieuId` et `visiteId` en plus. Capture d'écran d'une source : `media` de `role: "capture"`.

## 3. Écrans

1. **Onglet « Lieux »** (remplace « Idées ») : bibliothèque + carte, et en second plan les idées du voyage (étapes sans jour), inchangées.
2. **Filtres** : texte, ville/pays, catégorie, statut, verdict, saison, moment, étiquette, auteur, autour d'un point (ma position, hôtel du jour) avec rayon.
3. **Fiche du lieu** : en-tête (catégorie, statut, verdict, privé), nom local, photo de référence, source, direction, moments et saisons, accès, note ; visites (date, saison, verdict, phrase, photos, bouton carte postale) ; « Ajouter à une journée » ; « Fusionner avec… » ; modification.
4. **Capturer** (un geste, sur place) : photo (appareil du téléphone) ou sans photo ; position GPS et boussole si disponibles ; crée le lieu et sa visite du jour, puis propose en option catégorie, phrase et verdict. Hors ligne : tout est gardé et envoyé plus tard.
5. **Doublons** : à la création, un lieu existant à moins de 50 m est proposé (« ajouter une visite à… ») ; fusion manuelle depuis la fiche.
6. **Journée** : panneau « À voir près de ta journée » — lieux repérés à moins de ~10 min à pied (800 m à vol d'oiseau) d'une étape positionnée, triés par distance, avec la saison et le moment s'ils correspondent ; « Ajouter » crée l'étape liée. Repères sur la carte du jour quand « Idées » est actif.
7. **Étape** : dans sa fiche, « Lier à un lieu de la bibliothèque » ou « Créer le lieu ».

## 4. Carte postale

- Image JPEG à 300 dpi, une seule face, papier mat, aux proportions exactes du format choisi (ni bande blanche ni rognage au tirage) :

  | format | usage | pixels (paysage) |
  |---|---|---|
  | L (89 × 127 mm) | Japon, konbini | 1500 × 1050 |
  | 2L (127 × 178 mm) | Japon, konbini | 2100 × 1500 |
  | 10 × 15 cm | Europe | 1800 × 1200 |
  | 13 × 18 cm | Europe | 2126 × 1535 |

  Le dernier format choisi est retenu sur le téléphone ; par défaut L si le téléphone est à l'heure de Tokyo, sinon 10 × 15.
- Contenu : la photo, une mini-carte avec l'épingle (fond OpenStreetMap restylé façon washi), l'icône et le nom de la catégorie, le nom du lieu (et son nom local), la date, la phrase, le QR code `<code>/<n>` avec le code écrit en clair dessous.
- Deux gabarits : « Plein cadre » (photo pleine page, bandeau washi en bas) et « Carnet » (photo à gauche, colonne washi à droite).
- Sortie : enregistrer l'image ou la partager (impression au konbini depuis le téléphone, ou à la maison).
- Interdite pour un lieu privé.

## 5. QR code et lecteur

- Le QR code ne contient que l'identifiant (`TB-7K3M9Q/2`), pas d'adresse web.
- Lecteur dans Tabi (onglet Lieux, « Scanner ») : caméra, détection native du navigateur si elle existe, sinon bibliothèque jsQR embarquée ; saisie manuelle du code possible.
- Résolution : code → lieu (en suivant `mergedInto`) → visite `n`. Le lien code → stockage est fait par Tabi : si le stockage change, seule l'appli change.

## 6. Pour Claude

Le contrat `drive-readme.md` (v3) décrit `lieu` et `visite`. Claude peut créer des lieux repérés (`by: "Claude"`), avec la source de l'idée ; il ne crée pas de visite (une visite est vécue).

## 7. Critères d'acceptation

- Les journées, étapes, réservations et photos existantes s'affichent et se synchronisent comme avant.
- Un lieu capturé hors ligne garde sa photo et son code, et part à la synchronisation suivante.
- La carte postale générée a les dimensions exactes du format choisi (par exemple 1800 × 1200 en 10 × 15, 1500 × 1050 en L) et son QR code se relit avec le lecteur de Tabi.
- Un lieu privé n'offre ni carte postale ni QR code.
- La fusion conserve les visites, les photos et la résolution de l'ancien code.

## 8. Lot 2 (après le voyage)

Import de lieux à partir des photos du voyage (EXIF), migration des étapes passées vers la bibliothèque, exports PDF (fiche, sélection) et KML/GeoJSON, bibliothèque commune à plusieurs voyages (dossier Drive distinct).
