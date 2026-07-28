// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

// Le service worker n'est pas un module : c'est un script qui s'accroche à `self`.
// On l'évalue donc dans un bac à sable qui joue ce rôle, puis on lui envoie de fausses
// requêtes pour observer ce qu'il décide d'intercepter.
//
// Ce qui est testé ici n'est pas le cache mais l'AIGUILLAGE — quelles requêtes le
// service worker prend en charge. C'est là qu'un bug coûte cher : intercepter une
// redirection d'authentification cassait le passage de session vers l'application
// mobile, en silence, alors que tout le reste fonctionnait.

interface FetchListener { (event: FakeEvent): void }
interface FakeEvent {
  request: { method: string; url: string; mode?: string; destination?: string }
  respondWith: (value: unknown) => void
}

function loadServiceWorker(): FetchListener {
  const code = readFileSync(resolve(__dirname, '../../public/service-worker.js'), 'utf8')
  const listeners: Record<string, FetchListener> = {}

  const self = {
    addEventListener: (type: string, fn: FetchListener) => { listeners[type] = fn },
    location: { origin: 'https://sports.logicraft.ch' },
    skipWaiting: () => {},
    clients: { claim: async () => {} },
  }

  // Stubs juste assez complets pour que les branches interceptées s'exécutent sans
  // exploser : ce test observe l'aiguillage, pas le contenu du cache.
  const caches = {
    open: async () => ({ match: async () => undefined, put: async () => {} }),
    keys: async () => [],
    delete: async () => true,
  }

  new vm.Script(code).runInContext(vm.createContext({
    self, caches, fetch: async () => ({ ok: false, clone: () => ({}) }), Response, URL, console,
  }))

  return listeners.fetch
}

describe('service worker — aiguillage des requêtes', () => {
  let onFetch: FetchListener

  beforeEach(() => {
    onFetch = loadServiceWorker()
  })

  // Renvoie true si le service worker a pris la requête en charge.
  function intercepts(request: FakeEvent['request']): boolean {
    let handled = false
    onFetch({ request, respondWith: () => { handled = true } })
    return handled
  }

  it('laisse passer l\'échange de session de l\'application mobile', () => {
    // Régression : `/auth/handoff` répond une redirection qui pose le cookie de
    // session. Interceptée, elle partait en erreur réseau (dans un service worker,
    // `fetch()` d'une navigation qui redirige rejette) et l'appli s'ouvrait en
    // anonyme — sans itinéraires, sans fond de carte, sans POI.
    expect(intercepts({
      method: 'GET',
      url: 'https://sports.logicraft.ch/auth/handoff?token=abc&next=%2Fnavigate',
      mode: 'navigate',
    })).toBe(false)
  })

  it('laisse passer le retour de Keycloak', () => {
    expect(intercepts({
      method: 'GET',
      url: 'https://sports.logicraft.ch/auth/keycloak/callback?code=xyz',
      mode: 'navigate',
    })).toBe(false)
  })

  it('prend toujours en charge les autres navigations', () => {
    // Le hors-ligne de la navigation guidée en dépend : sans cette interception, une
    // page déjà visitée ne serait plus servie sans réseau.
    expect(intercepts({
      method: 'GET',
      url: 'https://sports.logicraft.ch/routes/abc/navigate',
      mode: 'navigate',
    })).toBe(true)
  })

  it('prend toujours en charge les assets buildés', () => {
    expect(intercepts({
      method: 'GET',
      url: 'https://sports.logicraft.ch/vite/assets/application-abc123.js',
      destination: 'script',
    })).toBe(true)
  })

  it('laisse passer les requêtes cross-origin', () => {
    // Tuiles WMTS, élévation S3 : réseau direct, jamais cachées ici.
    expect(intercepts({
      method: 'GET',
      url: 'https://tiles.example.com/12/34/56.png',
      destination: 'image',
    })).toBe(false)
  })
})
