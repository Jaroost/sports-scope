// Client API des POI sauvegardés (table `pois`, globaux à l'utilisateur).
// Persistance des points d'intérêt posés à la main dans le créateur ou épinglés
// depuis une découverte Overpass. Consommé par savedPoisStore (créateur + navigation).

// `category` est une clé du registre POI_CATEGORIES (poiCategories.ts). `source`
// distingue un POI posé à la main d'un POI Overpass épinglé.
export interface SavedPoi {
  id: number
  name: string
  category: string
  lat: number
  lng: number
  source: 'custom' | 'overpass'
}

// Champs modifiables d'un POI (création : tout requis sauf source ; mise à jour : partiel).
export interface SavedPoiInput {
  name: string
  category: string
  lat: number
  lng: number
  source?: 'custom' | 'overpass'
}

function csrfToken(): string {
  return document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || ''
}

const JSON_HEADERS = () => ({
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'X-CSRF-Token': csrfToken(),
})

// Liste les POI de l'utilisateur connecté. Renvoie [] si non connecté (302) ou en cas
// d'erreur — les POI sauvegardés ne sont qu'un complément, jamais bloquant.
export async function fetchSavedPois(): Promise<SavedPoi[]> {
  try {
    const res = await fetch('/api/pois', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    if (!res.ok) return []
    const payload = await res.json()
    return Array.isArray(payload.pois) ? payload.pois : []
  } catch {
    return []
  }
}

export async function createPoi(input: SavedPoiInput): Promise<SavedPoi | null> {
  try {
    const res = await fetch('/api/pois', {
      method: 'POST',
      headers: JSON_HEADERS(),
      credentials: 'same-origin',
      body: JSON.stringify(input),
    })
    if (!res.ok) return null
    return (await res.json()).poi ?? null
  } catch {
    return null
  }
}

export async function updatePoi(id: number, input: Partial<SavedPoiInput>): Promise<SavedPoi | null> {
  try {
    const res = await fetch(`/api/pois/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS(),
      credentials: 'same-origin',
      body: JSON.stringify(input),
    })
    if (!res.ok) return null
    return (await res.json()).poi ?? null
  } catch {
    return null
  }
}

export async function deletePoi(id: number): Promise<boolean> {
  try {
    const res = await fetch(`/api/pois/${id}`, {
      method: 'DELETE',
      headers: { 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin',
    })
    return res.ok
  } catch {
    return false
  }
}
