// Helpers d'affichage météo pour ActivityConditions.
// Les codes météo suivent la nomenclature WMO renvoyée par Open-Meteo ; on les
// regroupe en quelques familles associées à une icône FontAwesome et une clé i18n.
import { t } from './i18n'

export interface Weather {
  temperature: number | null
  humidity: number | null
  precipitation: number | null
  weather_code: number | null
  wind_speed: number | null
  wind_direction: number | null
  wind_gusts: number | null
  observed_at: string | null
}

interface WeatherBucket {
  icon: string
  key: string // sous-clé de strava.weather.codes.*
}

// Regroupe un code WMO en famille { icône, libellé }.
export function weatherBucket(code: number | null | undefined): WeatherBucket {
  if (code == null) return { icon: 'fa-cloud', key: 'unknown' }
  if (code === 0) return { icon: 'fa-sun', key: 'clear' }
  if (code <= 2) return { icon: 'fa-cloud-sun', key: 'partly_cloudy' }
  if (code === 3) return { icon: 'fa-cloud', key: 'overcast' }
  if (code <= 48) return { icon: 'fa-smog', key: 'fog' }
  if (code <= 57) return { icon: 'fa-cloud-rain', key: 'drizzle' }
  if (code <= 67) return { icon: 'fa-cloud-showers-heavy', key: 'rain' }
  if (code <= 77) return { icon: 'fa-snowflake', key: 'snow' }
  if (code <= 82) return { icon: 'fa-cloud-showers-heavy', key: 'rain_showers' }
  if (code <= 86) return { icon: 'fa-snowflake', key: 'snow_showers' }
  if (code <= 99) return { icon: 'fa-cloud-bolt', key: 'thunderstorm' }
  return { icon: 'fa-cloud', key: 'unknown' }
}

export function weatherLabel(code: number | null | undefined): string {
  return t(`strava.weather.codes.${weatherBucket(code).key}`)
}

const CARDINALS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const

// Direction cardinale d'OÙ vient le vent (convention météo), depuis un angle en degrés.
export function windCardinal(deg: number | null | undefined): string | null {
  if (deg == null || !Number.isFinite(deg)) return null
  const idx = Math.round(((deg % 360) + 360) % 360 / 45) % 8
  return t(`strava.weather.dir.${CARDINALS[idx]}`)
}

// Angle de la flèche (en degrés) indiquant le sens VERS lequel souffle le vent.
// Open-Meteo donne la direction d'origine → +180 pour le sens de déplacement.
// Une flèche « fa-arrow-up » pointe vers le haut (nord) à 0°.
export function windArrowDeg(deg: number | null | undefined): number {
  if (deg == null || !Number.isFinite(deg)) return 0
  return (deg + 180) % 360
}
