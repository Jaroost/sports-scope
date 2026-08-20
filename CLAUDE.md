# Sports Scope — Guide pour Claude

## Stack technique

- **Backend** : Ruby on Rails 8.1, PostgreSQL, Puma, Propshaft
- **Frontend** : Vue 3 (îlots), TypeScript, Vite + vite-plugin-ruby, Bootstrap 5, MapLibre GL, Chart.js
- **Auth** : OmniAuth (Keycloak SSO + Strava OAuth)
- **Gestionnaire de paquets JS** : pnpm 9
- **Environnement de développement** : Docker (le projet tourne dans des containers)

## Tests

Ne pas écrire de tests (Ruby, TS, ou côté dépôt voisin `sports-scope-companion`), même temporaires ou jetables pour sonder un comportement, et ne pas lancer la suite de tests existante — sauf demande explicite de l'utilisateur dans les deux cas.

## Démarrage

Le projet tourne dans Docker — on ne peut pas lancer `rails` ou `bundle` directement depuis le terminal hôte (ruby du système trop vieux). Utiliser les containers Docker pour exécuter des commandes Rails.

## Architecture Vue — îlots

Vue est monté en mode "îlots" : pas de SPA globale. Chaque composant s'attache à un élément HTML portant `data-vue-component="NomDuComposant"`.

Le registre des composants est dans `app/javascript/mountVueIslands.ts`. Pour ajouter un nouveau composant Vue, l'enregistrer dans ce fichier.

Les props sont passées via `data-vue-props='{"key":"value"}'` (JSON encodé dans l'attribut HTML).

## Structure JavaScript

```
app/javascript/
  entrypoints/
    application.ts      # point d'entrée Vite — initialise i18n puis monte les îlots
    application.scss    # styles globaux (Bootstrap + FontAwesome)
  components/           # composants Vue
  stores/               # stores Pinia (routeStore, selectionStore, placesStore)
  i18n.ts               # wrapper i18n-js — exporte t()
  locales/              # JSON auto-générés (gitignorés — ne pas éditer)
  mountVueIslands.ts    # registre + montage des îlots
  mapStyles.ts          # définitions des styles de carte MapLibre
  pageState.ts          # state partagé côté page (hors Pinia)
```

## Traductions (i18n)

**Source de vérité unique : `config/locales/fr.yml` et `config/locales/en.yml`.**

Ne jamais éditer `app/javascript/locales/fr.json` ou `en.json` directement — ces fichiers sont auto-générés par la gem `i18n-js` à chaque démarrage Rails et sont gitignorés.

### Ajouter une traduction

1. Ajouter la clé dans `config/locales/fr.yml` et `config/locales/en.yml`
2. Redémarrer Rails (les JSON sont régénérés automatiquement par `config/initializers/i18n-js.rb`)
3. Dans un composant Vue, importer et utiliser `t()` :

```typescript
import { t } from '../i18n'
// ...
t('routes.ma_nouvelle_cle')
```

### Configuration i18n-js

- Config : `config/i18n-js.yml` — exporte tout (`patterns: ["*"]`) vers `app/javascript/locales/:locale.json` (le placeholder doit être `:locale` — i18n-js 4.x ne reconnaît PAS `%{locale}` et écrirait alors un seul fichier nommé littéralement `%{locale}.json`)
- Initializer : `config/initializers/i18n-js.rb` — régénère les JSON au démarrage dans tous les environnements (dev, test, prod)
- En prod, les JSON sont générés lors du boot avant le build Vite (`assets:precompile` déclenche un boot Rails)

## Routes API

Les routes JSON consommées par Vue :

| Ressource | Préfixe |
|---|---|
| Activités Strava | `/strava/activities` |
| Activités importées (.fit) | `/api/imported_activities` |
| Itinéraires (CRUD + GPX) | `/api/routes` |
| Proxy geocoding Nominatim | `/api/geocode/places` |
| Préférences chart layouts | `/preferences/chart_layouts` |

Les pages Rails sont sous `scope "(:locale)", locale: /en|fr/` — le préfixe de langue est optionnel.

## Composants Vue principaux

| Composant | Rôle |
|---|---|
| `RouteBuilder.vue` | Éditeur d'itinéraire complet (carte + toolbar + modale export) |
| `RouteBuilderMap.vue` | Carte MapLibre de l'éditeur |
| `RouteBuilderChart.vue` | Graphique altitude/pente de l'éditeur |
| `RouteBuilderStats.vue` | Panneau latéral des statistiques de l'éditeur |
| `ActivityDetail.vue` | Détail d'une activité Strava |
| `ActivityCharts.vue` | Graphiques d'une activité (Chart.js) |
| `ActivityMapCard.vue` | Carte d'une activité |
| `ActivityStats.vue` | Stats d'une activité |
| `RoutesList.vue` | Liste des itinéraires sauvegardés |
| `ImportFitActivity.vue` | Import de fichiers .fit |

## BRouter auto-hébergé

Le routage n'utilise plus l'instance publique brouter.de (ni SLA ni quota). Deux services
dans les deux docker-compose :

| Service | Rôle |
|---|---|
| `brouter` | Le moteur (`RouteServer`), image buildée depuis les sources (`deploy/brouter/Dockerfile`, version épinglée `BROUTER_VERSION`) |
| `brouter-sync` | Télécharge et rafraîchit les données dans les volumes `brouter_segments` (tuiles `.rd5`) et `brouter_profiles` (profils `.brf` + `lookups.dat`) |

Il est servi sous le domaine de l'app via Traefik (`PathPrefix(/brouter)`, `Method(GET)`),
donc en **même origine** : pas de CORS, pas de certificat en plus. Côté front,
`BROUTER_URL` vaut `/brouter` par défaut (`app/javascript/brouter.ts`) — en prod les
`import.meta.env.VITE_*` sont figés au `assets:precompile`, d'où un défaut fonctionnel
plutôt qu'un build-arg.

- **Premier démarrage** : `brouter-sync` télécharge ~3,4 Go (Europe entière, 110 tuiles).
  Suivre l'avancement avec `docker compose logs -f brouter-sync`. `brouter` attend que
  `brouter-sync` soit *healthy*, c'est-à-dire que le marqueur `/segments4/.sync-complete`
  existe (au moins une tuile + `lookups.dat`) — le moteur ne démarre donc jamais sans
  données. Le marqueur vit dans le volume : **seul le tout premier boot attend**, les
  redémarrages suivants sont immédiats. Pour démarrer le moteur sans attendre (données
  partielles déjà présentes) : `docker compose up -d --no-deps brouter`.
- **Forcer une resynchro** : `docker compose run --rm brouter-sync bash /sync.sh`
- **Changer la couverture** : `BROUTER_BBOX` dans `.env` (`lon_min,lat_min,lon_max,lat_max`,
  grille de 5°). Les tuiles hors bbox déjà téléchargées ne sont pas supprimées.
- **Ajouter / figer un profil** : déposer le `.brf` dans `deploy/brouter/profiles/` (voir
  le README du dossier), puis le déclarer dans `PROFILES_BY_SPORT`
  (`app/javascript/brouter.ts`) et `ALLOWED_PROFILES`
  (`app/controllers/routes_controller.rb`).
- **Monter de version** : bumper `BROUTER_VERSION` dans `bin/release` et le tag d'image
  dans `deploy/docker-compose.prod.yml` + `docker-compose.yml`. `bin/release` ne rebuild
  l'image BRouter que si le tag est absent du registry (`BROUTER_FORCE=1` pour forcer).

La synchro écrit en `.part` puis renomme : aucun redémarrage de `brouter` n'est nécessaire
après une mise à jour des données.

## POI auto-hébergés

Les points d'intérêt ne viennent plus d'`overpass-api.de` (ni SLA ni quota). Le service
`poi-sync` (`deploy/osm-pois/`) importe périodiquement des extraits OpenStreetMap
Geofabrik dans une **base PostgreSQL dédiée** (`osm_pois_development` / `osm_pois_production`),
lue par `OsmPoi` via la connexion `osm` de `config/database.yml`.

Pipeline (`deploy/osm-pois/sync.sh`) : téléchargement conditionnel des `.osm.pbf` →
`osmium tags-filter` (ne garde que les tags utiles) → `osmium export` en GeoJSON,
**extrait par extrait** → `extract.py --country XX` (classification + CSV) → `COPY`
dans une table de transit → dédoublonnage → bascule atomique. L'app ne voit jamais de
table partielle.

L'export est fait extrait par extrait (et non sur une fusion `osmium merge`) pour que
chaque POI porte le pays de l'extrait dont il vient (`osm_pois.country`) : OSM ne
porte pas le pays sur les objets, et c'est cette colonne qui alimente les « pays
traversés » (`routes.countries`). Le pays d'un extrait est déduit de son URL
Geofabrik (`COUNTRY_CODES` dans `sync.sh`) ; un extrait absent de la table donne un
pays vide. Le dédoublonnage que faisait la fusion (objet présent dans deux extraits
frontaliers) est repris en SQL sur `(category, name, lat, lng)`, premier extrait
gagnant.

- **Premier démarrage** : ~2 Go d'extraits (Suisse + voisinage). Suivre avec
  `docker compose logs -f poi-sync`. Comme pour BRouter, `rails` attend que `poi-sync`
  soit *healthy* (marqueur `/data/.sync-complete`) — bloquant seulement au tout premier
  boot, le marqueur vivant dans le volume. Si le catalogue venait à manquer malgré tout,
  `/api/geocode/places` répond `places_unavailable` (le front affiche son bouton
  réessayer) et les jobs de localités retentent.
- **Forcer une resynchro** : `docker compose exec poi-sync /sync.sh`
- **Changer la couverture** : `OSM_POI_REGIONS` dans `.env` (URLs `.osm.pbf` Geofabrik
  séparées par des espaces). Les extraits retirés de la liste restent sur le volume mais
  ne sont plus chargés.
- **Ajouter une catégorie de POI** : le filtre dans `FILTERS` (`sync.sh`) + la
  classification dans `classify()` (`extract.py`) + `CATEGORIES_BY_TYPE` et
  `DEFAULT_POI_NAMES` (`app/controllers/geocodes_controller.rb`) + l'entrée dans
  `POI_CATEGORIES` (`app/javascript/poiCategories.ts`) + le booléen de préférence
  (`User::DEFAULT_PREFERENCES`, `ProfilesController`, `userPreferences.ts`,
  `UserProfile.vue`) + les libellés i18n. Une resynchro est nécessaire pour peupler la
  nouvelle catégorie.

`bin/release` rebuild et pousse l'image `sports-scope-poi-sync` à chaque release (elle
embarque `sync.sh` / `extract.py`, donc du code du repo).

### Recalcul des lieux (recherche par lieu) et des pays

Les lieux traversés (`routes.localities`, `strava_activities.localities`) sont extraits
automatiquement à chaque changement de tracé. Les **pays traversés**
(`routes.countries`, affichés sur la page de partage) sortent de la même passe : ce
sont les pays des localités retenues (`osm_pois.country`), donc un pays n'est listé que
si le tracé passe à moins de `LocalitiesExtractor::THRESHOLD_M` d'une de ses localités.
Un catalogue importé avant la colonne `country` donne simplement des pays vides — il
faut une resynchro (`docker compose exec poi-sync /sync.sh`) puis un recalcul.

Pour les retraiter en masse — `LocalitiesBackfill` + `lib/tasks/localities.rake` :

```bash
bin/rails localities:pending     # combien reste-t-il à traiter
bin/rails localities:backfill    # extrait ce qui manque (idempotent)
bin/rails localities:recompute   # réécrit TOUT (après un changement de couverture OSM,
                                 # de LocalitiesExtractor::THRESHOLD_M, ou une resynchro
                                 # qui vient de remplir les pays)
```

Options : `USER_ID=<id>`, `LIMIT=<n>` (par type), `SCOPE=routes|activities`.

L'extraction est faite en ligne, pas via les jobs : chaque enregistrement n'est qu'une
requête SQL locale (~5 ms). Ordre de grandeur mesuré : 730 activités en 4 s.

## Base de données

PostgreSQL. Credentials par défaut en dev : `postgres/postgres` sur `localhost:5432`, base `sports_scope_development`.

`config/database.yml` déclare deux connexions par environnement : `primary` (l'app) et
`osm` (les POI importés, `database_tasks: false` — hors migrations et hors `db/schema.rb`).

## Linting / CI

```bash
bin/ci          # lance la suite CI complète
bin/brakeman    # sécurité Rails
```

Pas de RuboCop : la gem a été retirée du projet (elle faisait planter les conteneurs de
debug RubyMine). Ne pas la réintroduire ni recréer de `.rubocop.yml`.

## Diffusion de l'app compagnon Android

L'APK de l'app compagnon (dépôt voisin `~/dev/sports-scope-companion`) est distribué
par le site, hors Play Store. Trois actions dans `CompanionController`, dont le
partage des rôles est le point à comprendre :

| Route | Accès | Pourquoi |
|---|---|---|
| `/companion` | connectés | l'app ne sert à rien sans compte (itinéraires, seuils, POI passent tous par la session) |
| `/companion/download` | connectés | c'est le fichier lui-même ; un APK en accès libre finit indexé |
| `/api/companion_version` | **public** | l'app n'a aucun cookie côté Dart et ne lit ici qu'un numéro de version |
| `/api/companion_settings` | connectés | les profils de sortie ; données de compte, donc authentifié (voir plus bas). Le `?grid=328x598` qu'y ajoute l'appli est la taille de sa grille — retenue au passage |
| `/companion/dashboard` | connectés | l'éditeur de ces profils |

Cet endpoint public **coupe explicitement la session**
(`request.session_options[:skip]`) : `set_locale` écrit dans la session à chaque
requête, ce qui poserait un `Set-Cookie` sur une réponse marquée `cache-control:
public` — un cache partagé garderait alors le cookie d'un visiteur pour le suivant.

Le binaire **n'est ni dans l'image ni dans `public/`** :

- l'image se build depuis ce dépôt et l'APK sort de l'autre — ce serait ~19 Mo par
  couche et un redéploiement du site pour livrer une version de l'app ;
- `public/` reçoit un an d'expiration (`config.public_file_server.headers`), le même
  piège que corrige déjà `service_worker_cache.rb`.

Il vit donc dans le volume `companion_apk` (monté sur `/app/storage/companion`), avec
un `manifest.json` que lit `CompanionRelease`. On publie sans redéployer :

```bash
script/push-apk.sh   # lit l'APK du dépôt voisin, vérifie signature et paquet, dépose
```

Le script lit `versionCode`/`versionName` **dans l'APK** et pas dans le `pubspec` du
dépôt voisin : c'est le fichier publié qui fait foi, et le versionCode est ce qui
déclenche la mise à jour côté app.

## Les profils de sortie de l'app compagnon

`CompanionSettings` décrit **ce que le téléphone affiche en roulant** : les pages du
tableau de bord dans l'ordre, leur contenu, les jeux de valeurs du bandeau, les
capteurs utilisés, les réglages radar. Un document JSON par utilisateur
(`users.companion_settings`), édité par l'îlot `CompanionDashboard`, lu par
l'application une fois par lancement et à chaque connexion.

Un document et pas une table par profil : l'appli récupère le tout en une requête et
le met en cache sur le téléphone, et l'éditeur édite le tout. Une table ferait payer
des jointures pour reconstituer à chaque fois la même chose.

**Le contrat est partagé avec le dépôt voisin.** Les clés de composants (`metric`,
`zones`, …), de modes (`big`, `bar_only`, …) et de mesures (`speed`, `power_np`, …)
sont celles de `lib/dashboard/` côté Dart. Y toucher demande de modifier les deux
dépôts.

### Une page derrière le menu, ou dans le défilement

Une page porte un booléen `menu`. Absent, elle reste dans le défilement ; vrai, elle
sort du `PageView` et se retrouve **dans le menu ⋮ de l'appli**, d'où elle s'ouvre
par-dessus tout le reste.

C'est ce qui rend composable une page qu'on ne lit **pas** en roulant — un bilan,
des répartitions, ce qu'on consulte à l'arrêt — sans la mettre à un glissé de la
carte, où elle passerait sous les yeux à chaque changement de page.

Trois choses à ne pas défaire :

- **Absent vaut « dans le défilement », des deux côtés.** Un document plus ancien
  que l'appli garde ses pages là où elles étaient ; une appli plus ancienne que le
  document ignore la clé et les montre toutes. L'erreur va donc toujours vers
  « visible », jamais vers « introuvable » — le seul sens acceptable pour une page
  qu'on a composée exprès.
- **Il faut au défilement une page qui ne soit pas la carte.** C'est l'en-tête
  d'une page de données qui porte le menu ; la carte n'en dessine pas. Deux
  façons de se retrouver sans rien, donc — tout ranger derrière le menu, ou ne
  laisser que la carte — et la seconde est la sournoise : le défilement existe,
  mais ce qu'on a rangé n'est atteignable par aucun geste. Dans les deux cas la
  première page rangée reprend sa place (`keep_one_swipeable` côté site,
  `RidePreset.ridePages` côté Dart, un test de chaque côté). L'éditeur éteint le
  bouton avant d'en arriver là (`canHideBehindMenu`), comme il borne déjà les
  étendues de cellules.
- **La carte ne s'y range jamais.** Le WebView est peint au fond de la pile pour
  toute la sortie, ce n'est pas une page qu'on ouvre et qu'on referme. Et
  `RidePreset.mapPageIndex` indexe **le défilement** et non `pages` : c'est ce que
  manipulent le `PageView`, le numéro de page annoncé (`RidePageFlash`) et le
  retour automatique.

La page ouverte vit **dans la pile de la coquille**, pas dans une route poussée :
le bandeau, les jauges du radar, le cadre d'alerte et les mètres de l'encoche
appartiennent à `RideShellPage`, et une route par-dessus les emporterait tous — on
consulte un bilan *pendant* une sortie, une voiture qui remonte doit s'y voir comme
ailleurs. Une alerte referme d'ailleurs la page (`_setMenuPage(null)` dans
`_decideReturn`) **avant** que la politique ne décide : elle juge sur `currentPage`,
et un bilan ouvert par-dessus la carte se serait lu « il y est déjà, rien à faire ».

### Colonnes d'une page qui défile

Une page `list` — ou une page `laps` en liste défilante, la même disposition
une fois le tour choisi (`sanitize_lap_blocks`, `LapBlocksLayout` côté Dart)
— peut se répartir en 1 à 4 colonnes (`Page.cols`, `MAX_LIST_COLS`) plutôt
qu'une seule pile pleine largeur. Contrairement à une grille, une colonne n'a
pas de hauteur à tenir : elle empile ses blocs dans l'ordre du document et
peut déborder, c'est toute la page qui défile alors d'un bloc, colonnes
comprises.

**Pas de position absolue par bloc.** Un premier réglage donnait à chaque
bloc une colonne cible (`col: 0..cols-1`) — lourd à composer : la plupart des
blocs devaient juste suivre le précédent, et choisir un index pour chacun
revenait à répondre à une question qui ne se posait presque jamais. Un bloc
reste donc par défaut dans la colonne de celui qui le précède (première
colonne pour le tout premier), et ne porte une clé que sur les points de
rupture (`place_list_blocks` côté Rails, `listSegmentsOf` — `lib/dashboard/
list_layout.dart` — côté Dart, doivent s'accorder sur où elles tombent) :

- `new_column` passe à la colonne suivante, avec retour à la première après
  la dernière ;
- `full_width` occupe toute la largeur, clôt le groupe de colonnes en cours
  et fait repartir la suite en première colonne — le composant qui « fusionne
  sur toutes les colonnes ».

Les deux sont incompatibles (`full_width` l'emporte) et sans effet sur une
page à une seule colonne — dans les deux cas la clé est alors simplement
omise plutôt qu'écrite sans effet, des deux côtés (`fitListBlocks` côté TS
fait le même ménage quand `cols` retombe à 1 dans l'éditeur).

Ces clés sont **fusionnées dans le bloc lui-même** plutôt que dans une
enveloppe à part comme `Cell` (`{row, col, row_span, col_span, block}`) :
une entrée reste le bloc, avec une clé de plus. Un document d'avant ce
réglage porte encore l'ancien `col` par bloc : ni `sanitize_block` (Rails)
ni `DashboardBlock.parse` (Dart) ne le connaissent, il disparaît donc comme
n'importe quelle clé inconnue et tous ses blocs retombent en première
colonne, dans l'ordre où ils étaient déjà — dégradé (l'arrangement en
colonnes se perd), jamais un bloc effacé.

Le rendu (`DashboardListBody`, partagé entre `DashboardPage` et
`LapListPage`, dépôt voisin) traverse les blocs une fois pour les regrouper
en tronçons — un groupe de colonnes classique, ou un bloc `full_width` seul
sur sa ligne — puis dessine chaque tronçon.

### Pourquoi un assainisseur ici alors que l'appli en a déjà un

L'application ne fait jamais confiance à ce document : elle ignore les clés
inconnues, retombe sur son tableau de bord intégré si rien n'est exploitable, et
garantit elle-même ce que le format ne peut pas dire — au plus une carte, quatre
cases de bandeau, pas de cellules qui se recouvrent. C'est ce qui permet de servir
un profil un peu en avance sur la version installée.

Mais elle le fait **en silence, et sur la route**. Si l'éditeur laissait composer une
cinquième case ou deux cartes, l'utilisateur verrait à l'écran quelque chose que son
téléphone jetterait sans un mot. D'où `CompanionSettings.sanitize`, qui applique les
mêmes règles là où elles peuvent encore se voir — et un `PATCH` qui **rend le document
assaini**, sur lequel l'éditeur se réaligne. Ce qu'on voit après « Enregistrer » est
exactement ce que l'appli recevra.

La règle qui gouverne tout : **le serveur peut être plus indulgent que l'application,
jamais moins.** Ce qui sort de `sanitize` doit être accepté *en entier* par le
décodeur Dart, sans qu'il ait à retirer quoi que ce soit. D'où deux écarts assumés,
tous deux dans le sens indulgent : une clé manquante est *fabriquée* plutôt que de
faire perdre le profil, une clé en double est *suffixée* plutôt que de faire
disparaître le profil qu'on vient de dupliquer.

Le même raisonnement vaut côté front : `companionSettings.ts` borne l'étendue d'une
cellule à la place réellement libre (`maxSpan`) au lieu de laisser l'assainisseur
retirer le recouvrement après coup — sinon la cellule voisine disparaîtrait à
l'enregistrement.

### Choisir un composant : des vignettes, pas des listes

Le contenu d'une page se choisit dans une dialogue (`CompanionBlockPicker`) où
**chaque façon de dessiner a sa vignette** (`CompanionBlockPreview`), et les composants
déjà posés sont dessinés là où ils sont — dans les cases de la grille comme dans les
lignes d'une page qui défile. Trois listes déroulantes (genre, mesure, mode)
demandaient de se figurer ce que « Jauge », « Aplat de zone » ou « Barre seule »
veulent dire, et la réponse n'arrivait qu'en pleine sortie, sur le seul écran qu'on ne
peut plus modifier.

Une vignette par couple **genre × mode** et non par genre : c'est le mode qui décide du
dessin. Le paramètre que le genre réclame — la mesure, la source — se règle en tête de
son groupe et redessine ses vignettes aussitôt : on choisit *sa* mesure dessinée. Un
tap pose le composant et referme.

La vignette d'une case de grille est **à la taille de cette case**, pas à celle de la
tuile qui la porte : une case de six colonnes fait 48 × 93 px sur le téléphone, et
étalée sur 11 rem elle promettait la place d'un chiffre confortable là où il n'y en a
pas. C'est le texte qui fixe l'échelle (`TILE_FONT`) et la boîte qui suit, si bien
qu'une petite case se dessine dans un timbre. Mettre chaque case à la taille de la
tuile aurait **inversé le repère** — la grande case, réduite pour tenir, aurait montré
un texte plus petit que la petite case agrandie. Le rapport à la tuile ne revient qu'en
plafond, pour les grilles si grossières qu'une case n'y tiendrait plus.

Trois choses à ne pas défaire :

- **La vignette est un fac-similé, pas un rendu partagé.** Le tableau de bord est écrit
  en Flutter (`lib/ride/blocks/` du dépôt voisin), il n'y a rien à réutiliser ici : le
  fond des cartes, la palette des zones et les libellés en dur y sont **recopiés à la
  main**, et doivent suivre quand le dépôt voisin les change.
- **Elle ne promet que ce que l'appli dessinera.** Une jauge n'existe que pour une
  mesure qui a des zones — sans plage, `MetricView` retombe sur le chiffre plein cadre,
  et la vignette fait de même. Les unités, elles, **ne sont pas traduites** : ce sont
  celles que le téléphone écrira, or l'appli est en français et ne connaît que le
  métrique.
- **La grille de l'éditeur garde les proportions de l'écran du téléphone** (largeur
  bornée, hauteur fixe, lignes en `1fr`). Étalée sur la largeur de la page, une grille
  de 2 × 2 donnait des cases en bandeau là où le cycliste en aura des carrés debout : on
  composait pour une mise en page qui n'existe nulle part. Les proportions sont
  exactement celles de `PHONE_GRID` (`companionSettings.ts`) : un seul facteur d'échelle
  vaut alors pour toutes les grilles, ce dont dépend `--cbp-em`.

### Le mode est un ordre, pas un plafond

Un profil décrit sa grille en lignes et en colonnes, jamais en pixels — c'est le
téléphone qui sait ce que ça fait (328 × 598 px logiques sur un écran ordinaire,
donc 48 × 93 par case en 6 × 6). Les composants écrits à taille fixe réclamaient
leur hauteur quelle que soit la case et **débordaient sur la voisine**, en
roulant.

Une première réponse retirait des éléments selon la taille — la légende cède la
place à sa barre, l'icône puis l'unité disparaissent — mais ça voulait dire
composer un mode sur le site sans savoir si le téléphone le dessinerait vraiment :
« Aplat de zone » choisi dans l'éditeur pouvait perdre son icône, sans un mot,
sur une case trop petite. Le mode qu'on choisit doit être celui qu'on obtient.

`BlockSurface` (`lib/ride/blocks/block_card.dart`, dépôt voisin) construit donc
**tout ce que le mode demande**, à une taille naturelle et fixe, puis
`ScaleToFit` réduit la carte entière — jamais un élément retiré, jamais un
agrandissement au-delà de la taille naturelle (une case généreuse resterait sinon
incohérente avec ses voisines). C'est le mécanisme qui existait déjà pour le
grand chiffre et la jauge radar (`FittedBox`), généralisé à toute carte : plus
aucun composant ne choisit quoi montrer selon la case, il choisit seulement à
quelle échelle.

Côté site, `companionSettings.ts` n'a donc plus de table de seuils à garder
synchronisée avec le dépôt voisin — `blockShape` ne dépend plus que du mode.
`previewScale` en est le pendant visuel : un rapport continu entre la case
réelle et une taille de référence, plafonné à 1, qui pose la `font-size` de
l'aperçu (`--cbp-em`, `tileStyle`) exactement comme `ScaleToFit` calculerait la
sienne. Une seule référence pour tous les genres, là où l'appli en détaille une
par genre : moins précis, mais assumé — l'aperçu est un fac-similé, pas un rendu
partagé, et l'approximation ne peut plus faire promettre un élément que le
téléphone retirerait, puisque plus rien n'est retiré.

`test/dashboard_overflow_test.dart` (dépôt voisin) monte les pires grilles
composables : un débordement y fait échouer le test, `flutter_test` remontant le
« RenderFlex overflowed » comme une erreur — ce que `ScaleToFit` doit justement
empêcher, quelle que soit la case.

### C'est le téléphone qui dit sa taille

`previewScale` compare des pixels, l'éditeur compose en lignes et en colonnes :
il lui faut donc savoir ce que ça fait sur l'écran. Il le **demandait** — un
téléphone de référence de 328 × 598 — jusqu'à ce que l'appli l'annonce.

Ce qui remonte est la grille et **non l'écran** : le rectangle que reçoit
vraiment `DashboardPage._grid`, barre système, en-tête et bandeau déjà retirés.
Le recalculer côté site depuis une taille d'écran dupliquerait cette mise en page
en un second endroit, qui dériverait au premier réglage changé — et une mesure
fausse vaut moins qu'une mesure absente, parce que le site la croirait.

Le chemin : `DashboardPage` mesure (`onGridMeasured`) → `CompanionSettingsStore`
la garde avec les profils → elle part en query sur la requête que l'appli faisait
déjà (`GET /api/companion_settings?grid=328x598`) → `users.companion_viewport`.
Un GET qui écrit, oui : imposer une seconde requête coûterait un WebView hors
écran de plus — une seconde d'attente à l'accueil — pour une information que le
site ne lit qu'en ouvrant l'éditeur.

`null` tant que rien n'a été mesuré, et c'est **exactement la distinction dont
l'éditeur a besoin** : la phrase sous la grille dit alors « à l'échelle d'un
téléphone ordinaire » (`scale_assumed`) plutôt que de prétendre connaître celui
de l'utilisateur (`scale_measured`). La valeur de repli est écrite des deux
côtés — `CompanionViewport::DEFAULT` et `PHONE_GRID` — et un test la compare.

### Le budget de charge : le seul composant que le site calcule

Le composant `training_budget` ne lit aucun capteur. Il répond à la question à
laquelle aucun capteur ne répond — *je continue ou je rentre ?* — et pour ça il
faut la charge des six dernières semaines, l'objectif d'entraînement et la cible
de la semaine. Deux modes : `day` (fait + sortie en cours / cible, plafond de
fatigue, fraîcheur, risque) et `week` (cible, fait, prévu, reste).

Le calcul **reste dans `useTrainingPlan.ts`**, celui qui alimente déjà la page
Performances, et la page de navigation le pousse par le pont
(`pushTrainingBudget`, `companionBridge.ts`, message `training_budget`) —
exactement comme elle pousse déjà `/api/rider_profile`. Le refaire en Ruby pour
servir l'appli donnerait deux plafonds pour un athlète, et le second à se tromper
serait celui qu'on lit en roulant.

Le TSS de la sortie **en cours** n'y est pas : elle n'est téléversée nulle part,
c'est le téléphone qui l'ajoute (`rideTss`, dépôt voisin), avec la même cascade
que `TrainingLoad.activity_tss` — puissance, puis cardio, puis l'intensité par
défaut du vélo.

Ce qui rend tout ça possible : **l'objectif d'entraînement est un réglage de
compte** (`preferences.training`), plus une clé de `localStorage`. C'est lui qui
fixe le plancher de fatigue, donc le plafond ; deux stockages locaux donneraient
deux plafonds, et celui de l'appli — qui lit le site depuis le WebView de
l'appareil — n'aurait jamais vu l'objectif choisi sur l'ordinateur. La reprise de
l'ancienne clé se fait une fois, au premier chargement, et seulement si le compte
est encore sur ses valeurs d'usine (`legacyPlan` / `initialPlan`).

### Le piège du PATCH

`sanitize` rend les profils par défaut quand il ne trouve rien d'exploitable. C'est
juste pour **afficher** et catastrophique pour **écrire** : un corps mal formé
remplacerait des profils composés à la main par ceux d'usine. `update` refuse donc
tout corps qui n'est pas un objet JSON (400) plutôt que d'écrire. Un corps carrément
illisible, lui, n'atteint jamais le contrôleur — le middleware de Rails répond 400
avant.

Le corps est lu par `request.raw_post` et non par `params` : le document est
profondément imbriqué et de forme libre, et le faire traverser
`ActionController::Parameters` demanderait un `to_unsafe_h` à chaque étage. C'est
sans risque parce que **l'assainisseur est la liste blanche** — il ne recopie rien, il
reconstruit à partir des seules clés qu'il connaît.

⚠️ `WellKnownController` (assetlinks) ne publie **qu'un seul** paquet, celui du TWA.
Activer l'App Link vérifié de l'app compagnon (`ch.logicraft.sports.companion`)
demande de le faire porter deux couples paquet/empreintes.
