import { ref, readonly } from 'vue'
import { csrfToken } from './csrf'
import { isLoggedIn } from './userPreferences'
import type { Sport } from './userPreferences'
import { specBase } from './routingProfile'
import { profilesForSport } from './brouter'
import { t } from './i18n'

// Profils de routage personnalisés du compte (/api/routing_profiles) : état partagé par
// tous les sélecteurs de la page, chargé une seule fois. Un profil nommé n'est qu'un
// libellé posé sur un spec (cf. routingProfile.ts) : les itinéraires, les préférences et
// les requêtes BRouter ne portent jamais que le spec.

export interface CustomRoutingProfile {
  id: number
  name: string
  spec: string
  sport: Sport
}

const items = ref<CustomRoutingProfile[]>([])
const loaded = ref(false)
let inflight: Promise<void> | null = null

export const customRoutingProfiles = readonly(items)

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' }

export function loadRoutingProfiles(): Promise<void> {
  if (loaded.value || !isLoggedIn()) return Promise.resolve()
  inflight ??= fetch('/api/routing_profiles', { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d) => {
      items.value = d.routing_profiles ?? []
      loaded.value = true
    })
    .catch(() => {
      // Silencieux : sans la liste, les profils de base restent utilisables.
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function customProfilesForSport(sport: Sport): CustomRoutingProfile[] {
  return items.value.filter((p) => p.sport === sport)
}

async function send(method: string, url: string, body?: unknown): Promise<CustomRoutingProfile | null> {
  const res = await fetch(url, {
    method,
    headers: { ...JSON_HEADERS, 'X-CSRF-Token': csrfToken() },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  })
  if (method === 'DELETE' && res.ok) return null
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || String(res.status))
  return data.routing_profile as CustomRoutingProfile
}

export async function saveRoutingProfile(
  existingId: number | null,
  attrs: { name: string; spec: string; sport: Sport },
): Promise<CustomRoutingProfile> {
  const saved = await send(
    existingId ? 'PATCH' : 'POST',
    existingId ? `/api/routing_profiles/${existingId}` : '/api/routing_profiles',
    attrs,
  )
  items.value = [...items.value.filter((p) => p.id !== saved!.id), saved!].sort((a, b) => a.name.localeCompare(b.name))
  return saved!
}

export async function deleteRoutingProfile(id: number): Promise<void> {
  await send('DELETE', `/api/routing_profiles/${id}`)
  items.value = items.value.filter((p) => p.id !== id)
}

// Profil nommé dont le spec est exactement celui-ci (pour le sport donné).
export function customProfileForSpec(spec: string, sport: Sport): CustomRoutingProfile | undefined {
  return items.value.find((p) => p.spec === spec && p.sport === sport)
}

// Libellé affichable d'un spec : profil de base traduit, nom du profil nommé, ou « base
// (personnalisé) » pour un réglage jamais enregistré.
export function profileLabel(spec: string, sport: Sport): string {
  if (!spec.includes('~') && profilesForSport(sport).includes(spec)) return t(`routes.brouter_profile.${spec}`)
  const named = customProfileForSpec(spec, sport)
  if (named) return named.name
  return t('routes.routing_profile.unsaved', { base: t(`routes.brouter_profile.${specBase(spec)}`) })
}

// Description d'un spec : celle de son profil de base.
export function profileDescription(spec: string): string {
  return t(`routes.brouter_profile.${specBase(spec)}_desc`)
}
