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

// URL synthétique (même origine) sous laquelle on stocke temporairement le GPX
// reçu via le Web Share Target, le temps que le créateur le récupère (one-shot).
const SHARED_GPX_URL = '/__shared_gpx__'

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

// Web Share Target (Android) : réception d'un .gpx partagé à l'app. Android POST
// le fichier (multipart) vers /routes/share-target. On le met en cache puis on
// redirige vers le créateur, qui le récupère via GET SHARED_GPX_URL.
async function handleSharedGpx(request) {
  try {
    const form = await request.formData()
    const file = form.get('gpx')
    if (file && typeof file !== 'string') {
      const cache = await caches.open(CACHE)
      await cache.put(
        SHARED_GPX_URL,
        new Response(file, {
          headers: {
            'Content-Type': 'application/gpx+xml',
            'X-Filename': encodeURIComponent(file.name || 'route.gpx'),
          },
        }),
      )
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
    event.respondWith(handleSharedGpx(request))
    return
  }

  if (request.method !== 'GET') return

  // Récupération one-shot du GPX partagé par le créateur : on sert depuis le cache
  // puis on purge l'entrée pour ne pas rejouer un vieux fichier au lancement suivant.
  if (reqUrl.pathname === SHARED_GPX_URL) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const cached = await cache.match(SHARED_GPX_URL)
        if (cached) await cache.delete(SHARED_GPX_URL)
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
