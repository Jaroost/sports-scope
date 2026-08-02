// Service worker de Sports Scope.
//
// Rôle :
//  1. Installabilité PWA (présence d'un handler `fetch`).
//  2. Permettre l'usage HORS-LIGNE de la navigation : la page, ses assets et le JSON du
//     trajet visités une fois en ligne restent disponibles sans réseau. Les TUILES de
//     carte, elles, ne transitent PAS par ce cache — elles sont pré-téléchargées en
//     archive PMTiles (cf. app/javascript/offline) et servies par MapLibre hors-ligne.
//
// Stratégies :
//  - navigation (HTML)        → réseau d'abord, repli sur le cache.
//  - assets Vite same-origin  → cache d'abord + rafraîchissement en arrière-plan (SWR).
//  - JSON du trajet partagé   → réseau d'abord, repli sur le cache.
//  - tout le reste / cross-origin (tuiles WMTS, OpenFreeMap, S3…) → réseau direct.

const CACHE = 'sports-scope-v3'

// URLs synthétiques (même origine) sous lesquelles on stocke temporairement le
// fichier reçu via le Web Share Target, le temps que la page le récupère (one-shot).
const SHARED_GPX_URL = '/__shared_gpx__'
const SHARED_FIT_URL = '/__shared_fit__'

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      await self.clients.claim()
    })(),
  )
})

async function networkFirst(request) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(request)
    if (res && res.ok) cache.put(request, res.clone())
    return res
  } catch (e) {
    const cached = await cache.match(request)
    if (cached) return cached
    throw e
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((res) => {
      if (res && res.ok) cache.put(request, res.clone())
      return res
    })
    .catch(() => cached)
  return cached || network
}

// Le « .FIT » de l'en-tête (octets 8 à 11), seul marqueur fiable du format — cf.
// `isFitFile` dans app/javascript/fitImport.ts, dont ceci est le jumeau : le service
// worker ne peut pas importer de module applicatif.
function looksLikeFit(bytes) {
  return bytes.length >= 12
    && bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54
}

// Web Share Target (Android) : réception d'un fichier partagé à l'app. Android POST
// le fichier (multipart) vers /routes/share-target. On le met en cache puis on
// redirige vers la page qui le consommera, laquelle le récupère par un GET one-shot.
//
// Le champ du formulaire ne décide de rien : Android partage très souvent un `.fit`
// en `application/octet-stream`, type que le paramètre `gpx` accepte déjà (il lui
// faut, des gestionnaires de fichiers partageant les GPX sous ce même type). Un `.fit`
// arriverait donc dans le champ `gpx` et le créateur d'itinéraire le lirait comme un
// XML illisible. On renifle les octets, et eux seuls.
async function handleSharedFile(request) {
  try {
    const form = await request.formData()
    const file = form.get('fit') || form.get('gpx')
    if (file && typeof file !== 'string') {
      const buf = await file.arrayBuffer()
      const isFit = looksLikeFit(new Uint8Array(buf))
      const cache = await caches.open(CACHE)
      await cache.put(
        isFit ? SHARED_FIT_URL : SHARED_GPX_URL,
        new Response(buf, {
          headers: {
            'Content-Type': isFit ? 'application/vnd.ant.fit' : 'application/gpx+xml',
            'X-Filename': encodeURIComponent(file.name || (isFit ? 'activite.fit' : 'route.gpx')),
          },
        }),
      )
      if (isFit) {
        // Un `.fit` peut être une sortie à journaliser comme un parcours à suivre :
        // c'est la page d'atterrissage qui le lit et laisse choisir.
        return Response.redirect(new URL('/import/fit?fromShare=1', self.location.origin).href, 303)
      }
    }
  } catch (e) {
    /* partage illisible : on ouvre quand même un créateur vierge */
  }
  // 303 : force le navigateur à suivre en GET (navigation vers le créateur).
  // Response.redirect exige une URL absolue.
  return Response.redirect(new URL('/routes/new?fromShare=1', self.location.origin).href, 303)
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  const reqUrl = new URL(request.url)

  // POST du Web Share Target : intercepté avant le filtre GET ci-dessous.
  if (request.method === 'POST' && reqUrl.pathname === '/routes/share-target') {
    event.respondWith(handleSharedFile(request))
    return
  }

  if (request.method !== 'GET') return

  // Authentification : jamais interceptée, jamais cachée.
  //
  // Ces réponses sont des REDIRECTIONS qui posent un cookie de session :
  // `/auth/handoff` échange le jeton du lien « ouvrir dans l'application » contre
  // une session, `/auth/<provider>/callback` clôt le tour de Keycloak. Les faire
  // passer par `networkFirst` cassait la navigation : dans un service worker,
  // `fetch()` d'une requête de navigation qui répond une redirection rejette, et le
  // repli sur le cache ne trouve évidemment rien — la promesse de `respondWith`
  // partait donc en erreur réseau. Résultat côté appli : le passage de session
  // échouait en silence et la navigation s'ouvrait en anonyme.
  //
  // Ne pas répondre du tout laisse le navigateur suivre la redirection lui-même,
  // cookie compris. Rien à mettre en cache ici de toute façon : une session ne
  // s'ouvre pas hors ligne.
  if (reqUrl.pathname.startsWith('/auth/')) return

  // Récupération one-shot du fichier partagé par la page qui le consomme : on sert
  // depuis le cache puis on purge l'entrée pour ne pas rejouer un vieux fichier au
  // lancement suivant.
  if (reqUrl.pathname === SHARED_GPX_URL || reqUrl.pathname === SHARED_FIT_URL) {
    const key = reqUrl.pathname
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const cached = await cache.match(key)
        if (cached) await cache.delete(key)
        return cached || new Response('', { status: 404 })
      })(),
    )
    return
  }

  const url = reqUrl
  const sameOrigin = url.origin === self.location.origin

  // Cross-origin (tuiles WMTS / OpenFreeMap / élévation S3…) : réseau direct, jamais caché.
  if (!sameOrigin) return

  // Navigation : réseau d'abord, repli cache.
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  // JSON du trajet partagé (consommé par la page de navigation) : réseau d'abord, repli cache.
  if (url.pathname.includes('/api/routes/shared/')) {
    event.respondWith(networkFirst(request))
    return
  }

  // Assets buildés (Propshaft / vite-plugin-ruby) + polices/styles/scripts : SWR.
  const dest = request.destination
  if (url.pathname.startsWith('/vite/') || url.pathname.startsWith('/assets/') ||
      dest === 'script' || dest === 'style' || dest === 'font') {
    event.respondWith(staleWhileRevalidate(request))
  }
})
