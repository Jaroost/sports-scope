// Référentiel des pays pour la priorisation de la recherche de lieux (profil).
//
// - `ALL_COUNTRY_CODES` : univers des pays sélectionnables (ISO 3166-1 alpha-2,
//   en minuscules), utilisé par le sélecteur « Ajouter un pays » du profil.
// - `countryName(cc)` : nom localisé du pays (via Intl.DisplayNames, dans la
//   langue de l'interface) ; repli sur le code en majuscules si indisponible.
// - `countryFlag(cc)` : drapeau emoji dérivé du code (indicateurs régionaux).
//
// L'ordre choisi par l'utilisateur est stocké dans ses préférences
// (`search.country_codes`) et piloté côté serveur — cf. User::DEFAULT_PREFERENCES.

import { i18n } from './i18n'

// ISO 3166-1 alpha-2 (minuscules). Liste large couvrant le monde ; on s'appuie
// sur Intl.DisplayNames pour les noms localisés, donc pas besoin de les stocker.
export const ALL_COUNTRY_CODES: string[] = [
  'ad', 'ae', 'af', 'ag', 'al', 'am', 'ao', 'ar', 'at', 'au', 'az',
  'ba', 'bb', 'bd', 'be', 'bf', 'bg', 'bh', 'bi', 'bj', 'bn', 'bo', 'br', 'bs', 'bt', 'bw', 'by', 'bz',
  'ca', 'cd', 'cf', 'cg', 'ch', 'ci', 'cl', 'cm', 'cn', 'co', 'cr', 'cu', 'cv', 'cy', 'cz',
  'de', 'dj', 'dk', 'dm', 'do', 'dz',
  'ec', 'ee', 'eg', 'er', 'es', 'et',
  'fi', 'fj', 'fr',
  'ga', 'gb', 'gd', 'ge', 'gh', 'gm', 'gn', 'gq', 'gr', 'gt', 'gw', 'gy',
  'hn', 'hr', 'ht', 'hu',
  'id', 'ie', 'il', 'in', 'iq', 'ir', 'is', 'it',
  'jm', 'jo', 'jp',
  'ke', 'kg', 'kh', 'ki', 'km', 'kn', 'kp', 'kr', 'kw', 'kz',
  'la', 'lb', 'lc', 'li', 'lk', 'lr', 'ls', 'lt', 'lu', 'lv', 'ly',
  'ma', 'mc', 'md', 'me', 'mg', 'mk', 'ml', 'mm', 'mn', 'mr', 'mt', 'mu', 'mv', 'mw', 'mx', 'my', 'mz',
  'na', 'ne', 'ng', 'ni', 'nl', 'no', 'np', 'nz',
  'om',
  'pa', 'pe', 'pg', 'ph', 'pk', 'pl', 'pt', 'py',
  'qa',
  'ro', 'rs', 'ru', 'rw',
  'sa', 'sb', 'sc', 'sd', 'se', 'sg', 'si', 'sk', 'sl', 'sm', 'sn', 'so', 'sr', 'ss', 'st', 'sv', 'sy', 'sz',
  'td', 'tg', 'th', 'tj', 'tl', 'tm', 'tn', 'to', 'tr', 'tt', 'tv', 'tz',
  'ua', 'ug', 'us', 'uy', 'uz',
  'va', 'vc', 've', 'vn', 'vu',
  'ws',
  'xk',
  'ye',
  'za', 'zm', 'zw',
]

// Cache des instances Intl.DisplayNames par locale (création non triviale).
const displayNamesCache = new Map<string, Intl.DisplayNames | null>()

function displayNames(): Intl.DisplayNames | null {
  const locale = i18n.locale || 'en'
  if (displayNamesCache.has(locale)) return displayNamesCache.get(locale)!
  let dn: Intl.DisplayNames | null = null
  try {
    dn = new Intl.DisplayNames([locale], { type: 'region' })
  } catch { dn = null }
  displayNamesCache.set(locale, dn)
  return dn
}

// Nom localisé du pays (« Suisse » / « Switzerland »). Repli sur le code en
// majuscules si Intl.DisplayNames n'est pas disponible ou ne connaît pas le code.
export function countryName(cc: string): string {
  const upper = cc.toUpperCase()
  try {
    return displayNames()?.of(upper) || upper
  } catch {
    return upper
  }
}

// Drapeau emoji dérivé du code pays : chaque lettre est convertie en symbole
// indicateur régional (U+1F1E6 = 'A'). Renvoie '' pour un code mal formé.
export function countryFlag(cc: string): string {
  if (!/^[a-z]{2}$/i.test(cc)) return ''
  const A = 0x1f1e6
  const base = 'a'.charCodeAt(0)
  return String.fromCodePoint(
    A + (cc.toLowerCase().charCodeAt(0) - base),
    A + (cc.toLowerCase().charCodeAt(1) - base),
  )
}
