import { ref, watch } from 'vue'
import { userPreferences } from '../userPreferences'

// ─── Recherche de lieu (Nominatim, filtrée par les pays du profil) ─────────────
// Logique partagée par le créateur d'itinéraire et les modes de navigation : on
// interroge Nominatim en restreignant aux pays privilégiés du profil
// (search.country_codes), avec repli mondial optionnel, et on trie les résultats
// selon l'ordre de priorité des pays. Le composant appelant décide quoi faire d'un
// résultat (recadrer la carte, etc.) — ce composable ne gère que la recherche.

export interface PlaceResult {
  place_id: number
  display_name: string
  lat: string
  lon: string
  boundingbox?: string[]
  address?: { country_code?: string }
}

export function usePlaceSearch() {
  // Liste ordonnée des pays privilégiés, configurée dans le profil
  // (search.country_codes). L'ordre = la priorité d'affichage ; on la passe aussi
  // en `countrycodes` à Nominatim pour qu'il ne renvoie d'abord que ces pays.
  const PREFERRED_COUNTRIES = userPreferences().search.country_codes
  const PREFERRED_COUNTRY_CODES = PREFERRED_COUNTRIES.join(',')
  // Étendre la recherche au monde entier quand aucun résultat n'est trouvé dans les
  // pays privilégiés (réglage du profil ; false par défaut).
  const WORLDWIDE_FALLBACK = userPreferences().search.worldwide_fallback

  const searchQuery = ref('')
  const searchResults = ref<PlaceResult[]>([])
  const searchOpen = ref(false)
  const searching = ref(false)
  let searchTimer: ReturnType<typeof setTimeout> | null = null

  // Rang de priorité d'un pays = sa position dans la liste du profil ; les pays
  // hors liste (repli mondial) passent après tous les autres.
  function searchCountryPriority(cc: string): number {
    const i = PREFERRED_COUNTRIES.indexOf(cc)
    return i === -1 ? PREFERRED_COUNTRIES.length : i
  }

  async function fetchPlaces(q: string, countrycodes?: string): Promise<PlaceResult[]> {
    let url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=jsonv2&limit=10&addressdetails=1`
    if (countrycodes) url += `&countrycodes=${countrycodes}`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return []
    const raw = await res.json()
    return Array.isArray(raw) ? raw : []
  }

  async function searchPlaces(q: string) {
    searching.value = true
    try {
      // On restreint d'abord aux pays privilégiés ; si Nominatim ne renvoie rien
      // (lieu hors zone) et que le repli mondial est activé, on refait une recherche
      // mondiale. Liste vide ⇒ recherche mondiale d'emblée (pas de second appel).
      let data = await fetchPlaces(q, PREFERRED_COUNTRY_CODES)
      if (data.length === 0 && PREFERRED_COUNTRY_CODES && WORLDWIDE_FALLBACK) data = await fetchPlaces(q)
      searchResults.value = data
        .sort((a, b) => searchCountryPriority(a.address?.country_code ?? '') - searchCountryPriority(b.address?.country_code ?? ''))
        .slice(0, 6)
      searchOpen.value = searchResults.value.length > 0
    } catch { searchResults.value = []; searchOpen.value = false }
    finally { searching.value = false }
  }

  watch(searchQuery, (q) => {
    if (searchTimer) clearTimeout(searchTimer)
    const trimmed = q.trim()
    if (trimmed.length < 3) { searchResults.value = []; searchOpen.value = false; return }
    searchTimer = setTimeout(() => searchPlaces(trimmed), 350)
  })

  function clearSearch() {
    if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
    searchQuery.value = ''
    searchResults.value = []
    searchOpen.value = false
  }

  return { searchQuery, searchResults, searchOpen, searching, searchPlaces, clearSearch }
}
