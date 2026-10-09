import { t } from './i18n'

// Fichier JSON d'import/export d'un programme d'entraînement. Le contenu est celui que
// l'API sert et accepte (`name`, `sport`, `items` : blocs et groupes de répétition) ;
// l'enveloppe `format` + `version` permet de reconnaître un fichier qui n'en est pas un
// et de refuser, plus tard, un fichier plus récent que le site. Le serveur reste la
// seule autorité : il reconstruit et valide tout à l'enregistrement.

export const FORMAT = 'sports-scope-training-program'
export const VERSION = 1
export const MAX_FILE_BYTES = 1024 * 1024

export interface ProgramFile {
  name: string
  sport: string
  items: unknown[]
}

export function serializeProgram(program: { name: string; sport: string; items: unknown[] }): string {
  return JSON.stringify({ format: FORMAT, version: VERSION, name: program.name, sport: program.sport, items: program.items }, null, 2)
}

// Un nom de fichier sûr à partir du nom du programme.
export function fileNameFor(name: string): string {
  const slug = name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${slug || 'programme'}.json`
}

export function downloadText(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

// Lève une Error au message affichable si le fichier n'est pas un programme exploitable.
export function parseProgramFile(text: string): ProgramFile {
  let data: any
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(t('training_programs.import_error_invalid'))
  }
  if (!data || typeof data !== 'object' || data.format !== FORMAT || !Array.isArray(data.items) || data.items.length === 0) {
    throw new Error(t('training_programs.import_error_invalid'))
  }
  if (typeof data.version === 'number' && data.version > VERSION) {
    throw new Error(t('training_programs.import_error_version'))
  }
  return {
    name: typeof data.name === 'string' ? data.name : '',
    sport: typeof data.sport === 'string' ? data.sport : 'cycling',
    items: data.items,
  }
}
