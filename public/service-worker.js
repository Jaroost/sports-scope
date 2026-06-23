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

const CACHE = 'sports-scope-v2'

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

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
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
