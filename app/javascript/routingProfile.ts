import catalog from './routingProfileParams.json'

// Profils de routage personnalisés.
//
// Un profil personnalisé est un profil BRouter de base + des surcharges de variables
// (`&profile:<variable>=<valeur>`, cf. les `assign … # %nom%` des .brf). Il voyage
// partout comme une simple chaîne, le « spec » :
//
//   trekking-paved                                  profil de base, sans surcharge
//   trekking-paved~cost_surface_soft=10000~consider_noise=true
//
// Garder une chaîne (et non un objet) laisse intacts les `profile: string` de tout le
// code de routage et la clé de cache des tronçons (`legKey`), qui distingue ainsi deux
// réglages d'un même profil. Le spec est aussi ce que l'itinéraire enregistre : il reste
// reproductible même si le profil nommé est modifié ou supprimé ensuite.
//
// Forme canonique : clés triées, et seules les valeurs qui DIFFÈRENT du défaut du profil
// sont écrites — un spec sans surcharge est donc exactement le nom du profil de base.
// Le catalogue (`routingProfileParams.json`) est partagé avec Rails (RoutingProfileSpec),
// qui s'en sert de liste blanche.

export type ParamValue = boolean | number

export interface ParamDef {
  type: 'bool' | 'number' | 'choice'
  default: ParamValue
  group: string
  min?: number
  max?: number
  step?: number
  values?: number[]
  // Jeu de libellés d'un choix : 'cost' (autorisé/évité/interdit), 'level' (idéal … interdit),
  // 'sac' (T0…T6), 'mtb' (S0…S6).
  labels?: 'cost' | 'level' | 'sac' | 'mtb'
}

interface ProfileDef {
  // Preset : profil de l'atelier dont seules les valeurs par défaut changent. BRouter ne connaît
  // que le profil `extends` ; le preset n'existe que dans le catalogue.
  extends?: string
  params: string[]
  defaults: Record<string, ParamValue>
}

const PARAMS = catalog.params as Record<string, ParamDef>
const PROFILES = catalog.profiles as Record<string, ProfileDef>

export const SPEC_SEPARATOR = '~'

// Anciens profils maison (.brf supprimés) → preset de l'atelier qui les remplace. Un spec
// enregistré avant la suppression continue de router, avec ses surcharges (mêmes clés).
const REMOVED_PROFILE_ALIASES: Record<string, string> = {
  'trekking-paved': 'preset-cycling-trekking',
  'fastbike-quiet-paved': 'preset-cycling-fast-quiet',
}

// Profil de base d'un spec (ce qui précède le premier séparateur).
export function specBase(spec: string): string {
  const i = spec.indexOf(SPEC_SEPARATOR)
  return i < 0 ? spec : spec.slice(0, i)
}

// Un profil de base accepte-t-il des réglages ?
export function isCustomizable(base: string): boolean {
  return base in PROFILES
}

// Variables réglables d'un profil de base, dans l'ordre du catalogue.
export function paramKeysFor(base: string): string[] {
  return PROFILES[base]?.params ?? []
}

export function paramDef(key: string): ParamDef | undefined {
  return PARAMS[key]
}

// Valeur par défaut d'une variable pour un profil de base.
export function defaultValue(base: string, key: string): ParamValue {
  const d = PROFILES[base]?.defaults
  if (d && key in d) return d[key]
  return PARAMS[key].default
}

function coerce(key: string, raw: unknown): ParamValue | undefined {
  const def = PARAMS[key]
  if (!def) return undefined
  if (def.type === 'bool') {
    if (raw === true || raw === 'true') return true
    if (raw === false || raw === 'false') return false
    return undefined
  }
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return undefined
  if (def.type === 'choice') return def.values!.includes(n) ? n : undefined
  return Math.min(def.max!, Math.max(def.min!, n))
}

// Lit un spec. Tolérant : une variable inconnue pour ce profil ou une valeur illisible est
// ignorée (le profil retombe sur son défaut) plutôt que de faire échouer le routage.
export function parseSpec(spec: string): { base: string; params: Record<string, ParamValue> } {
  const [rawBase, ...rest] = spec.split(SPEC_SEPARATOR)
  const base = REMOVED_PROFILE_ALIASES[rawBase] ?? rawBase
  const allowed = new Set(paramKeysFor(base))
  const params: Record<string, ParamValue> = {}
  for (const part of rest) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq)
    if (!allowed.has(key)) continue
    const v = coerce(key, part.slice(eq + 1))
    if (v !== undefined) params[key] = v
  }
  return { base, params }
}

// Forme canonique d'un profil de base + surcharges (cf. en-tête).
export function buildSpec(base: string, params: Record<string, ParamValue>): string {
  const parts: string[] = []
  for (const key of paramKeysFor(base).slice().sort()) {
    if (!(key in params)) continue
    const v = coerce(key, params[key])
    if (v === undefined || v === defaultValue(base, key)) continue
    parts.push(`${key}=${v}`)
  }
  return [base, ...parts].join(SPEC_SEPARATOR)
}

// Valeur effective d'une variable pour un spec (surcharge, sinon défaut du profil).
export function effectiveValue(spec: string, key: string): ParamValue {
  const { base, params } = parseSpec(spec)
  return key in params ? params[key] : defaultValue(base, key)
}

// Fragment de requête BRouter : `profile=<base>&profile:<k>=<v>…`. Seul point où un spec
// devient une URL — tous les appels de routage passent par ici.
export function brouterProfileQuery(spec: string): string {
  const { base, params } = parseSpec(spec)
  const engine = PROFILES[base]?.extends
  // Un preset est envoyé comme son profil d'atelier + toutes les valeurs qui s'en écartent.
  const sent: Record<string, ParamValue> = {}
  if (engine) {
    for (const key of paramKeysFor(base)) {
      const v = key in params ? params[key] : defaultValue(base, key)
      if (v !== defaultValue(engine, key)) sent[key] = v
    }
  } else Object.assign(sent, params)
  let q = `profile=${encodeURIComponent(engine ?? base)}`
  // BRouter lit ses variables comme des nombres : `true` fait échouer le profil (500), il
  // faut `1` / `0`. Le spec garde `true` / `false`, plus lisible.
  for (const [k, v] of Object.entries(sent)) q += `&profile:${k}=${typeof v === 'boolean' ? (v ? 1 : 0) : v}`
  return q
}

// Groupes de variables dans l'ordre d'affichage de l'éditeur.
export const PARAM_GROUPS = [
  'roads',
  'ways',
  'surface',
  'difficulty',
  'traffic',
  'cycleroutes',
  'elevation',
  'ambiance',
  'access',
] as const

export function paramKeysInGroup(base: string, group: string): string[] {
  return paramKeysFor(base).filter((k) => PARAMS[k].group === group)
}
