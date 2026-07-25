// Progression le long du tracé suivi, persistée dans le localStorage (une entrée par
// trajet).
//
// La position GPS seule ne distingue pas les passages d'un tracé qui se recoupe : au même
// endroit, lng/lat peut appartenir à 2–3 passages. On mémorise donc le sommet courant et
// on s'en sert comme indice au premier fix après un rechargement, pour repartir sur le bon
// passage au lieu d'une recherche globale ambiguë. L'entrée expire vite afin de ne pas
// « téléporter » un coureur qui relance la même route un autre jour ; la validité est en
// plus confirmée par la proximité réelle au fix GPS (sinon repli global, cf.
// nearestGeomIndexPreferring).
//
// Complémentaire de `sportsScope.navSession` (navSession.ts), qui mémorise QUEL tracé on
// suit ; ici on mémorise OÙ on en est.

const PREFIX = 'sportsScope.navProgress.'
// Au-delà, la progression mémorisée ne dit plus rien de l'endroit où l'on est.
const MAX_AGE_MS = 30 * 60 * 1000
// Écriture au plus toutes les 3 s : la progression change à chaque fix GPS, et le
// localStorage est synchrone.
const SAVE_INTERVAL_MS = 3000

// Clé de reprise dérivée du trajet actif (token de partage), ou 'none' en mode libre et
// pour une destination ad hoc. Dérivée à chaque appel (et non figée au montage) car
// l'itinéraire peut être chargé ou changé en cours de séance.
export function progressKey(token: string | null): string {
  return `${PREFIX}${token ?? 'none'}`
}

// Indice de reprise (sommet) si une progression récente est mémorisée pour ce trajet,
// sinon -1. `vertexCount` borne le résultat : un tracé recalculé depuis l'écriture a
// d'autres indices, mieux vaut une recherche globale qu'un indice hors-tracé.
export function loadProgress(token: string | null, vertexCount: number): number {
  try {
    const key = progressKey(token)
    const raw = localStorage.getItem(key)
    if (!raw) return -1
    const saved = JSON.parse(raw) as { idx: number; t: number }
    if (!saved || typeof saved.idx !== 'number' || typeof saved.t !== 'number') return -1
    if (Date.now() - saved.t > MAX_AGE_MS) { localStorage.removeItem(key); return -1 }
    return saved.idx >= 0 && saved.idx < vertexCount ? saved.idx : -1
  } catch { return -1 }
}

// Sauvegarde throttlée de la progression. Best-effort : un localStorage indisponible
// (mode privé, quota) ne doit pas casser la séance. Renvoie l'horodatage de la dernière
// écriture retenue, à repasser tel quel à l'appel suivant (`lastSaveMs`) — l'état du
// throttle reste ainsi chez l'appelant, et le module sans mémoire cachée.
export function saveProgress(token: string | null, idx: number, lastSaveMs: number): number {
  const now = Date.now()
  if (now - lastSaveMs < SAVE_INTERVAL_MS) return lastSaveMs
  try { localStorage.setItem(progressKey(token), JSON.stringify({ idx, t: now })) } catch { /* indisponible : best-effort */ }
  return now
}

/** Oublie la progression d'un trajet (son tracé vient de changer). */
export function clearProgress(token: string | null): void {
  try { localStorage.removeItem(progressKey(token)) } catch { /* quota / mode privé */ }
}

// Oublie TOUTES les progressions mémorisées, pas seulement celle du trajet actif. Une
// entrée corrompue ou obsolète peut faire repartir la navigation sur le mauvais passage
// d'un tracé auto-recoupant et donc dérailler les alertes de virage / arrivée : la
// réinitialisation manuelle (Réglages) repart d'une ardoise propre.
export function clearAllProgress(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k && k.startsWith(PREFIX)) localStorage.removeItem(k)
    }
  } catch { /* stockage indisponible */ }
}
