# Sports Scope

Rails 8 application demonstrating:

- **PostgreSQL 18.4** (two separate instances: app DB + Keycloak DB)
- **Keycloak** for SSO/IAM (`keycloak/keycloak`, realm `sports-scope` auto-imported)
- **Strava OAuth** for linking athlete accounts and pulling activities
- **Vite dev server** with HMR (separate Docker service)
- **pnpm** for JS dependencies
- **Vue 3 islands** mounted into Rails-rendered views
- **Bootstrap 5** for styling
- **i18n-js** to share Rails translations with the JS side (FR / EN)

Everything runs in Docker; tested under WSL2 + Docker Desktop.

---

## Quick start

```bash
cp .env.example .env
# ➤ Edit .env: fill STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET
docker compose up --build
```

Once everything is up:

| Service      | URL                            |
|--------------|--------------------------------|
| Rails app    | http://localhost:3000          |
| Vite HMR     | http://localhost:3036          |
| Keycloak     | http://localhost:8080          |
| App DB       | postgres://localhost:5432      |
| Keycloak DB  | postgres://localhost:5433      |

Default credentials:

- Keycloak admin: `admin` / `admin` (from `KEYCLOAK_ADMIN_PASSWORD`)
- Pre-seeded realm user: `demo@sports-scope.local` / `demopass`

---

## Auth architecture

```
                                   ┌──────────────┐
        login (OIDC)               │              │
   ┌──────────────────────────────►│   Keycloak   │
   │                               │              │
   │                               └──────────────┘
   │
┌──┴──┐    link Strava (OAuth)     ┌──────────────┐
│Rails├──────────────────────────► │    Strava    │
└──┬──┘    GET /api/v3/...         └──────────────┘
   │
   │
   ▼ stores tokens in users table
```

- **Primary login** is delegated to Keycloak via `omniauth_openid_connect`.
- **Strava** is wired as a *separate* OmniAuth strategy (`/auth/strava`) that the
  signed-in user triggers from the dashboard. The access / refresh tokens are
  stored on `User#strava_*` columns and refreshed on-demand via
  `User#refresh_strava_token!`.

> **Note on "Strava as Keycloak Identity Provider":**
> Keycloak ships only OIDC + named social brokers. Strava is pure OAuth 2.0
> (no id_token), and no public Strava SPI exists for Keycloak today. To wire
> Strava *through* Keycloak you would need a custom Java SPI dropped into
> `/opt/keycloak/providers/`. The hybrid approach used here keeps Keycloak
> as the user directory while still letting the signed-in user pull their
> Strava data — which was the actual end goal.

---

## Setting up a Strava developer app

1. Open https://www.strava.com/settings/api
2. Create an application.
3. Set **Authorization Callback Domain** to `localhost`.
4. Copy the *Client ID* and *Client Secret* into `.env`:
   ```
   STRAVA_CLIENT_ID=...
   STRAVA_CLIENT_SECRET=...
   ```
5. Restart the stack: `docker compose up -d`.

---

## Common commands

```bash
# Boot everything (rebuild image if needed)
docker compose up --build

# Tear it all down (keep volumes)
docker compose down

# Reset DB volumes (DESTRUCTIVE)
docker compose down -v

# Rails console
docker compose exec rails bundle exec rails console

# Run a migration
docker compose exec rails bundle exec rails db:migrate

# Add a JS dep
docker compose exec vite pnpm add some-package

# Add a gem (then rebuild)
# 1. edit Gemfile
docker compose run --rm rails bundle install
docker compose up -d --build rails vite
```

---

## File layout

```
sports-scope/
├── Dockerfile                      # Ruby 3.3 + Node 22 + pnpm (rails + vite share this)
├── docker-compose.yml              # 5 services
├── compose/keycloak/
│   └── realm-export.json           # imported on first boot
├── app/
│   ├── controllers/
│   │   ├── sessions_controller.rb  # OmniAuth callbacks
│   │   ├── strava_controller.rb    # /strava/activities (JSON)
│   │   └── pages_controller.rb
│   ├── javascript/
│   │   ├── entrypoints/application.js
│   │   ├── components/HelloStrava.vue
│   │   ├── stylesheets/application.scss
│   │   ├── locales/{en,fr}.json
│   │   ├── i18n.js
│   │   └── mountVueIslands.js
│   └── models/user.rb
├── config/
│   ├── database.yml
│   ├── vite.json
│   ├── i18n-js.yml
│   ├── initializers/omniauth.rb
│   └── locales/{en,fr}.yml
├── lib/omni_auth/strategies/strava.rb
├── package.json                    # pnpm@9
└── vite.config.mts
```

---

## Smoke test

After `docker compose up`, with `.env` filled in:

1. http://localhost:8080 → admin console works, realm `sports-scope` present.
2. http://localhost:3000 → home page renders with Bootstrap navbar.
3. Click **Sign in** → redirected to Keycloak → log in as `demo@sports-scope.local`
   / `demopass` → bounced back to Rails, signed in.
4. Open `/dashboard` → click **Connect Strava** → authorize on Strava →
   redirected back, tokens stored.
5. The Vue `HelloStrava` island fetches `/strava/activities` and renders your
   5 most recent activities.
6. Toggle the URL `?locale=fr` → labels switch to French (both server and JS).
7. Edit `app/javascript/components/HelloStrava.vue` → Vite HMR reloads the
   component without a full refresh.

---

## WSL notes

- Make sure the project lives inside the WSL filesystem (`~/...`), not under
  `/mnt/c/...` — bind mounts are much faster on the native FS.
- If HMR drops connections, that's why `vite.config.mts` enables polling
  (`server.watch.usePolling`).
- The Strava callback URL registered with Strava must be `localhost`; Strava
  does not accept private IPs.
