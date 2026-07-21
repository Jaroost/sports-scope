# Sports Scope — Guide pour Claude

## Stack technique

- **Backend** : Ruby on Rails 8.1, PostgreSQL, Puma, Propshaft
- **Frontend** : Vue 3 (îlots), TypeScript, Vite + vite-plugin-ruby, Bootstrap 5, MapLibre GL, Chart.js
- **Auth** : OmniAuth (Keycloak SSO + Strava OAuth)
- **Gestionnaire de paquets JS** : pnpm 9
- **Environnement de développement** : Docker (le projet tourne dans des containers)

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

## Base de données

PostgreSQL. Credentials par défaut en dev : `postgres/postgres` sur `localhost:5432`, base `sports_scope_development`.

## Linting / CI

```bash
bin/ci          # lance la suite CI complète
bin/rubocop     # Ruby linting
bin/brakeman    # sécurité Rails
```
