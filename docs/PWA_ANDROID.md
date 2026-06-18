# Sports Scope — PWA & app Android (TWA)

Ce document explique comment Sports Scope a été transformé en **PWA installable**
puis comment l'emballer en **application Android** publiable sur le Play Store,
sans dupliquer le code (une seule base Rails + Vue).

Domaine de production : `https://sports.logicraft.ch`

---

## Vue d'ensemble

```
Phase 1 — Rendre le site "PWA" (installable)          ✅ FAIT
   → manifest + service worker + icônes + HTTPS

Phase 2 — Emballer la PWA en app Android (.aab)       ⏳ À FAIRE sur ta machine
   → Bubblewrap génère le projet Android → signature → Play Store
```

- **Phase 1** : entièrement dans le repo Rails.
- **Phase 2** : surtout sur ta machine avec l'outil **Bubblewrap** ; le seul ajout
  repo est l'endpoint `assetlinks.json` (déjà en place).

Pourquoi cette approche (TWA) plutôt que Capacitor/React Native/Flutter ?
Sports Scope est **rendu côté serveur** (Rails + îlots Vue), pas une SPA statique.
Emballer le site déjà hébergé dans une **Trusted Web Activity** réutilise tout
l'existant, ne demande quasi aucun changement de code, et les mises à jour
serveur sont instantanées (pas besoin de republier sur le Play Store pour un
changement de contenu). Si un jour on a besoin de fonctions natives (GPS en
arrière-plan, notifications push), on migrera vers **Capacitor**.

---

## Phase 1 — PWA (✅ fait et validé)

Une PWA = le site actuel + 3 ingrédients que Chrome Android reconnaît pour
proposer « Installer l'application ».

### Fichiers ajoutés / modifiés

| Fichier | Rôle |
|---|---|
| `public/manifest.webmanifest` | Web App Manifest (nom, icônes, `display: standalone`, couleurs, `start_url`) |
| `public/service-worker.js` | Service worker minimal avec handler `fetch` (requis pour l'installabilité ; pas encore d'offline) |
| `public/icon-192.png` | Icône 192×192 (générée depuis `icon.png`) |
| `public/icon-512.png` | Icône 512×512 |
| `app/views/layouts/application.html.erb` | `<link rel="manifest">` + `theme-color` + balises apple-touch-icon |
| `app/javascript/entrypoints/application.ts` | Enregistrement du service worker (**production uniquement**) |
| `config/initializers/mime_types.rb` | Sert le manifest en `application/manifest+json` (sinon Rails renvoie `text/plain`, refusé par Chrome) |

### Choix de design

- `theme_color: #212529` pour matcher la navbar `bg-dark` (la barre de statut
  Android se fond avec).
- Icônes déclarées `any maskable` : l'icône a un fond noir plein avec le
  pictogramme centré → elle passe le recadrage Android sans bricolage.
- Service worker enregistré **uniquement en production** (`import.meta.env.PROD`)
  pour ne pas casser le HMR de Vite en dev.
- `start_url: /?source=pwa` pour distinguer plus tard le trafic venant de l'app
  installée.
- Le service worker ne fait **pas encore de cache offline** : il se contente de
  laisser passer les requêtes (handler `fetch` vide). C'est suffisant pour
  « juste installable ». L'offline s'ajoutera dans ce handler plus tard.

### Le piège MIME (résolu)

Rails ne connaît pas l'extension `.webmanifest` et la sert par défaut en
`text/plain`, ce que Chrome peut **refuser** (manifest ignoré → non installable).
Corrigé par `config/initializers/mime_types.rb` :

```ruby
Rack::Mime::MIME_TYPES[".webmanifest"] = "application/manifest+json"
```

⚠️ **Cloudflare** est devant le site et met `public/` en cache 1 an. Après tout
changement d'un fichier PWA, **purger le cache CF** de l'URL concernée
(dashboard → Caching → Purge Custom URL).

### Tester la PWA

1. Déployer sur `https://sports.logicraft.ch` (HTTPS obligatoire pour une PWA).
2. Chrome Android → menu ⋮ → « **Installer l'application** » doit apparaître.
3. Desktop : DevTools → **Application → Manifest** (aucune erreur) et
   **Service Workers** (`activated`).
4. **Lighthouse → PWA** : « installable » au vert.

Vérifs `curl` :
```bash
curl -sI https://sports.logicraft.ch/manifest.webmanifest | grep -i content-type
# attendu : content-type: application/manifest+json
curl -sI https://sports.logicraft.ch/service-worker.js
# attendu : HTTP/2 200
```

---

## Phase 2 — App Android (TWA via Bubblewrap)

Une fois la PWA valide, **Bubblewrap** (outil officiel Google) lit le manifest et
génère un projet Android qui n'est qu'une coquille affichant le site en plein
écran. C'est une **TWA** (Trusted Web Activity) : pas de WebView bricolée, c'est
le moteur Chrome du téléphone → rendu identique au navigateur.

### Changements repo (déjà en place)

| Fichier | Rôle |
|---|---|
| `app/controllers/well_known_controller.rb` | Sert `assetlinks.json`, alimenté par 2 variables d'env |
| `config/routes.rb` | Route `GET /.well-known/assetlinks.json` |

L'endpoint renvoie **404 tant que les variables d'env ne sont pas définies**
(normal — on les renseigne une fois l'empreinte connue) :

```
ANDROID_PACKAGE_NAME       ex. "ch.logicraft.sports"
ANDROID_CERT_FINGERPRINTS  empreintes SHA-256 séparées par des virgules
                           (clé d'upload locale + clé de signature Play)
```

### 1. Installer Bubblewrap

```bash
npm install -g @bubblewrap/cli
```

Au premier lancement, il propose d'installer le **JDK 17** et l'**Android SDK**
automatiquement — accepter.

### 2. Générer le projet Android

```bash
mkdir ~/sports-scope-android && cd ~/sports-scope-android
bubblewrap init --manifest https://sports.logicraft.ch/manifest.webmanifest
```

Réponses suggérées :

- **Package name** : `ch.logicraft.sports` (domaine inversé — ira dans
  `ANDROID_PACKAGE_NAME`)
- **App name / launcher name** : `Sports Scope`
- **Display mode** : `standalone` (déjà dans le manifest)
- **Signing key** : laisser **créer le keystore** → génère `android.keystore`.
  ⚠️ **Sauvegarder ce fichier + les mots de passe** : sans eux, impossible de
  publier une mise à jour plus tard.

### 3. Récupérer l'empreinte SHA-256 et la déployer

```bash
bubblewrap fingerprint list
```

Copier l'empreinte `SHA-256` (format `AA:BB:CC:...`), puis dans la config
d'environnement du déploiement :

```bash
ANDROID_PACKAGE_NAME=ch.logicraft.sports
ANDROID_CERT_FINGERPRINTS=AA:BB:CC:...
```

Redéployer, **purger le cache Cloudflare** de `/.well-known/assetlinks.json`,
puis vérifier :

```bash
curl -s https://sports.logicraft.ch/.well-known/assetlinks.json
```

Validateur officiel : <https://developers.google.com/digital-asset-links/tools/generator>

### 4. Construire l'app

```bash
bubblewrap build
```

Produit :

- `app-release-signed.apk` → pour **tester sur un téléphone**
  (`adb install app-release-signed.apk` ou copie directe).
- `app-release-bundle.aab` → pour le **Play Store**.

### 5. Test décisif

Installer l'APK sur un Android. Si l'app s'ouvre **en plein écran sans barre
d'URL** → `assetlinks.json` est bien lu, tout est bon. Si une barre d'adresse
apparaît, l'empreinte/le déploiement assetlinks n'est pas actif (souvent un
cache CF à purger).

---

## ⚠️ Le piège classique du Play Store (Play App Signing)

Au premier upload du `.aab`, Google active **Play App Signing** et **re-signe**
l'app avec *sa propre* clé → l'empreinte change.

Après le premier upload : **Play Console → Configuration → Intégrité de l'app →
Clé de signature d'application**, copier le **SHA-256** affiché, et **l'ajouter**
à la variable (les deux empreintes, séparées par une virgule) :

```bash
ANDROID_CERT_FINGERPRINTS=<empreinte_upload_locale>,<empreinte_signature_Play>
```

Sinon l'app installée *depuis le Play Store* affiche la barre d'URL alors que
l'APK de test fonctionnait. C'est l'erreur n°1 sur les TWA.

---

## Phase 3 — Publication Play Store (hors code)

- Compte développeur Google Play : **25 $ une fois**.
- Créer la fiche : description, captures d'écran, icône, **politique de
  confidentialité** (obligatoire).
- Uploader le `.aab`, passer la revue (quelques heures à quelques jours).

---

## Maintenance

- **Une seule base de code** : on continue à développer Rails/Vue normalement.
  L'app affiche toujours la dernière version en ligne — pas besoin de republier
  sur le Play Store à chaque changement de contenu.
- On ne republie le `.aab` que si on change le nom, l'icône, ou les permissions.
- À chaque modif d'un fichier PWA servi en cache long (manifest, service worker,
  assetlinks) : **purger le cache Cloudflare** de l'URL concernée.

### Mise en garde service worker + Cloudflare

Le serveur applique `cache-control: max-age=1 an` à tout `public/`, donc aussi à
`service-worker.js`. Les navigateurs revalident le SW d'eux-mêmes, **mais
Cloudflare** peut resservir un vieux SW. Le jour où on modifie le service worker
(ex. pour ajouter l'offline), **purger le cache CF** de ce fichier — sinon les
utilisateurs gardent l'ancien. Option propre future : une Cache Rule Cloudflare
(ou un middleware Rails) servant `service-worker.js` en `no-cache`.

---

## Pistes d'évolution

- **Offline** : implémenter une stratégie de cache dans le handler `fetch` du
  service worker (ex. cache-first sur les assets, network-first sur les pages).
- **Fonctions natives** (GPS arrière-plan, notifications push) : migration vers
  **Capacitor** (wrapper natif autour de la web app).
- **Alternative à Bubblewrap en CLI** : **PWABuilder** (<https://www.pwabuilder.com>),
  interface web qui génère le `.aab` à partir de l'URL du site.
