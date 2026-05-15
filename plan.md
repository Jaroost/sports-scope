# Plan — Application Rails 8 « sports_scope » (Docker / WSL)

## Context

Point de départ : `/home/user/sports-scope` est un dossier vide sous WSL. On veut bootstrapper une application web Rails 8 dont l'authentification est déléguée à Keycloak, lui-même configuré comme broker OAuth vers Strava (afin que Rails puisse, via le token broker de Keycloak, appeler l'API Strava pour récupérer les activités de l'utilisateur connecté). Le front utilise Vue.js en îlots montés depuis des vues Rails, Bootstrap pour le CSS, i18n-js pour partager les traductions Rails côté JS, le tout bundlé par Vite (serveur dev dédié) avec pnpm comme gestionnaire de paquets. Tout s'exécute en conteneurs orchestrés par docker-compose.

But final : `docker compose up` ⇒ Rails sur `http://localhost:3000`, Vite HMR sur `http://localhost:3036`, Keycloak admin sur `http://localhost:8080`, bouton « Se connecter avec Strava » fonctionnel, et un endpoint Rails de démo qui appelle `GET https://www.strava.com/api/v3/athlete/activities` avec le token broker.

---

## Architecture des services Docker

`docker-compose.yml` à la racine, 5 services :

| Service        | Image / build              | Port hôte | Rôle |
|----------------|----------------------------|-----------|------|
| `db_app`       | `postgres:18.4`            | 5432      | DB Rails (`sports_scope_development` / `_test`) |
| `db_keycloak`  | `postgres:18.4`            | 5433      | DB dédiée Keycloak |
| `keycloak`     | `keycloak/keycloak:latest` | 8080      | IAM, realm importé au boot |
| `rails`        | build `./` (Dockerfile)    | 3000      | App Rails (puma) |
| `vite`         | même image que `rails`     | 3036      | `bin/vite dev` — HMR |

Volumes nommés : `db_app_data`, `db_keycloak_data`, `bundle_cache`, `node_modules_cache`.
Network par défaut docker-compose ; Rails contacte `keycloak:8080` et `db_app:5432` par nom de service.

Variables sensibles dans `.env` (gitignoré) + `.env.example` versionné :
- `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`
- `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`
- `RAILS_KEYCLOAK_CLIENT_SECRET`
- `RAILS_MASTER_KEY` (généré par `rails new`)

---

## Fichiers à créer

### Racine

- `Dockerfile` — multi-stage basé sur `ruby:3.3-slim`, installe Node 22 + `pnpm` via corepack, copie Gemfile, fait `bundle install`, `pnpm install`. Image partagée Rails/Vite ; la commande est définie dans `docker-compose.yml`.
- `docker-compose.yml` — voir tableau ci-dessus. Healthcheck sur `db_app` et `db_keycloak`. `rails` dépend de `db_app` (healthy) et `keycloak` (started). `vite` partage les volumes code + `node_modules_cache`.
- `.dockerignore` — exclut `tmp/`, `log/`, `node_modules/`, `.git/`.
- `.env.example`, `.env` (gitignoré)
- `bin/docker-entrypoint` — wait-for db, `bundle exec rails db:prepare`, puis `exec "$@"`.
- `bin/dev-up`, `bin/dev-down` — wrappers shell facultatifs autour de docker compose.
- `README.md` — instructions WSL (cf. section Verification).

### App Rails (générée puis ajustée)

Commande de génération initiale (exécutée *via* un conteneur ruby jetable pour ne pas polluer WSL) :
```
docker run --rm -v $PWD:/app -w /app ruby:3.3-slim bash -lc \
  "gem install rails -v '~> 8.0' && rails new . --database=postgresql --javascript=vite --skip-test --skip-jbuilder --force"
```

Puis ajustements :

- `Gemfile` — ajouter :
  - `gem 'vite_rails'` (déjà via `--javascript=vite`)
  - `gem 'omniauth'`, `gem 'omniauth_openid_connect'`, `gem 'omniauth-rails_csrf_protection'`
  - `gem 'i18n-js', '~> 4'`
  - `gem 'faraday'` (pour appeler Keycloak broker + Strava API)
  - `gem 'dotenv-rails'` (group :development, :test)
- `config/database.yml` — host `db_app`, user `postgres`, password depuis ENV.
- `config/vite.json` — `host: '0.0.0.0'`, `port: 3036`, `origin: 'http://localhost:3036'`.
- `config/initializers/omniauth.rb` — provider `:openid_connect` avec :
  - `discovery: true`
  - `issuer: 'http://keycloak:8080/realms/sports-scope'`
  - `client_id: 'rails-app'`, `client_secret: ENV['RAILS_KEYCLOAK_CLIENT_SECRET']`
  - `scope: [:openid, :profile, :email]`
  - `redirect_uri: 'http://localhost:3000/auth/openid_connect/callback'`
- `config/initializers/i18n-js.rb` + `config/i18n.yml` (config gem) — export vers `app/javascript/locales/` au boot dev.
- `config/locales/en.yml`, `config/locales/fr.yml` — squelette de traductions.
- `app/controllers/sessions_controller.rb` — actions `create` (callback OmniAuth → sauve user + tokens en session), `destroy`.
- `app/controllers/strava_controller.rb` — action `activities` : récupère le token Strava via `GET http://keycloak:8080/realms/sports-scope/broker/strava/token` (header Bearer = access_token Keycloak), puis appelle Strava API.
- `app/models/user.rb` — `keycloak_uid`, `email`, `display_name`. Migration associée.
- `config/routes.rb` — `get '/auth/:provider/callback' => 'sessions#create'`, `delete '/logout' => 'sessions#destroy'`, `get '/strava/activities' => 'strava#activities'`, root `pages#home`.

### Front-end (Vite + pnpm)

- `package.json` — manager `pnpm@9`, dépendances :
  - `vite`, `vite-plugin-ruby`, `@vitejs/plugin-vue`
  - `vue@^3.4`
  - `bootstrap@^5.3`, `@popperjs/core`, `sass`
  - `i18n-js` (runtime côté JS, lit le JSON exporté par la gem)
- `pnpm-workspace.yaml` — pas nécessaire (mono-package), mais `.npmrc` avec `node-linker=hoisted` pour compatibilité Vite.
- `vite.config.ts` — `RubyPlugin()` + `vue()`. Configure `server.host = '0.0.0.0'`, `server.hmr.host = 'localhost'`.
- `app/javascript/entrypoints/application.js` — point d'entrée Vite, importe Bootstrap JS, SCSS, monte les îlots Vue via `data-vue-component` (helper `mountVueIslands.js`).
- `app/javascript/stylesheets/application.scss` — `@import "bootstrap/scss/bootstrap";` + overrides.
- `app/javascript/components/HelloStrava.vue` — composant de démo qui appelle `/strava/activities` et affiche les 5 dernières.
- `app/javascript/i18n.js` — wrapper i18n-js qui consomme `app/javascript/locales/*.json` produits par la gem.
- `app/views/layouts/application.html.erb` — `<%= vite_client_tag %>`, `<%= vite_javascript_tag 'application' %>`, `<%= vite_stylesheet_tag 'application' %>`.

### Keycloak

- `compose/keycloak/realm-export.json` — realm `sports-scope` contenant :
  - Client `rails-app` (confidential, standard flow, redirect `http://localhost:3000/*`, web origin `+`)
  - Identity Provider `strava` :
    - `authorizationUrl`: `https://www.strava.com/oauth/authorize`
    - `tokenUrl`: `https://www.strava.com/oauth/token`
    - `userInfoUrl`: `https://www.strava.com/api/v3/athlete`
    - `clientId` / `clientSecret` : placeholders → résolus via env Keycloak `STRAVA_CLIENT_ID/SECRET`
    - `defaultScope`: `read,activity:read_all`
    - **`storeToken: true`**, **`storedTokensReadable: true`** ← indispensable pour que Rails récupère le token Strava
  - Rôle client `broker.read-token` accordé au service-account / mappé sur l'utilisateur connecté.
- Keycloak démarre avec `--import-realm` (mount `./compose/keycloak:/opt/keycloak/data/import:ro`).
- Le client_secret du client `rails-app` est fixé dans le JSON pour matcher `RAILS_KEYCLOAK_CLIENT_SECRET`.

---

## Flow d'authentification + accès API Strava

1. Utilisateur clique « Login » → Rails redirige `/auth/openid_connect` → Keycloak.
2. Keycloak affiche bouton « Strava » (IDP) → redirection OAuth Strava → callback Keycloak → callback Rails (`/auth/openid_connect/callback`).
3. Rails reçoit `id_token` + `access_token` Keycloak, crée/retrouve un `User`, stocke `access_token` en `session`.
4. Quand le front appelle `/strava/activities`, le contrôleur Rails :
   - Faraday `GET http://keycloak:8080/realms/sports-scope/broker/strava/token`
   - Header `Authorization: Bearer #{session[:kc_access_token]}`
   - Réponse = `access_token=...&token_type=Bearer` (Strava token)
   - Faraday `GET https://www.strava.com/api/v3/athlete/activities?per_page=5` avec ce token
   - Renvoie JSON au composant Vue.

---

## Étapes d'exécution (ordre d'implémentation)

1. **Squelette docker** : `Dockerfile`, `docker-compose.yml`, `.env.example`, `bin/docker-entrypoint`.
2. **Générer Rails** via `docker run` jetable (voir commande ci-dessus).
3. **Ajuster `Gemfile`, `database.yml`, `config/vite.json`** ; `docker compose build`.
4. **Installer deps front** : `docker compose run --rm rails pnpm install` ; ajouter bootstrap/vue/i18n-js.
5. **Configurer Vite + Vue + Bootstrap** (`vite.config.ts`, entrypoint, SCSS).
6. **Générer realm Keycloak** (`compose/keycloak/realm-export.json`) ; démarrer Keycloak ; vérifier accès console admin.
7. **Brancher OmniAuth OIDC** côté Rails ; créer `SessionsController` + modèle `User`.
8. **Implémenter `StravaController#activities`** + composant Vue `HelloStrava`.
9. **Configurer i18n-js** + traductions fr/en de démonstration.
10. **README.md** avec procédure de démarrage et obtention credentials Strava.

---

## Fichiers critiques (chemins absolus)

- `/home/user/sports-scope/docker-compose.yml`
- `/home/user/sports-scope/Dockerfile`
- `/home/user/sports-scope/.env.example`
- `/home/user/sports-scope/compose/keycloak/realm-export.json`
- `/home/user/sports-scope/Gemfile`
- `/home/user/sports-scope/package.json`, `pnpm-lock.yaml`
- `/home/user/sports-scope/vite.config.ts`
- `/home/user/sports-scope/config/database.yml`
- `/home/user/sports-scope/config/initializers/omniauth.rb`
- `/home/user/sports-scope/config/initializers/i18n-js.rb`
- `/home/user/sports-scope/app/controllers/sessions_controller.rb`
- `/home/user/sports-scope/app/controllers/strava_controller.rb`
- `/home/user/sports-scope/app/javascript/entrypoints/application.js`
- `/home/user/sports-scope/app/javascript/components/HelloStrava.vue`
- `/home/user/sports-scope/app/javascript/stylesheets/application.scss`

---

## Vérification (smoke test end-to-end)

Pré-requis WSL :
- Docker Desktop avec intégration WSL activée, ou Docker Engine natif dans WSL2.
- Compte développeur Strava : créer une app sur https://www.strava.com/settings/api → callback URL `http://localhost:8080/realms/sports-scope/broker/strava/endpoint`. Renseigner `STRAVA_CLIENT_ID/SECRET` dans `.env`.

Étapes :
1. `cp .env.example .env` puis remplir les secrets.
2. `docker compose up --build` — attendre que Rails affiche « Listening on 0.0.0.0:3000 » et Keycloak « Running the server ».
3. Ouvrir `http://localhost:8080` → login admin (`admin` / `$KEYCLOAK_ADMIN_PASSWORD`) → vérifier realm `sports-scope` + IDP Strava présents.
4. Ouvrir `http://localhost:3000` → cliquer « Login » → choisir Strava sur la page Keycloak → autoriser → retour sur Rails authentifié.
5. Aller sur `/strava/activities` (ou page d'accueil avec composant Vue monté) → vérifier que 5 activités Strava réelles sont affichées (preuve que le token broker fonctionne).
6. Changer la langue (URL `?locale=fr`) → vérifier que les libellés bougent (preuve i18n-js).
7. Modifier `HelloStrava.vue` → vérifier le HMR via Vite (rechargement instantané sans `F5`).
8. `docker compose exec rails bundle exec rails test` (test minimal de routes / sessions).

Si l'étape 5 échoue avec `404` sur le broker token, vérifier dans Keycloak admin que l'IDP Strava a bien `Store Tokens = ON` et `Stored Tokens Readable = ON`, et que l'utilisateur a relogué depuis l'activation.
