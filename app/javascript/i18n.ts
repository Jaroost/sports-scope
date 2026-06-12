import { I18n } from 'i18n-js'

export const i18n = new I18n()

export async function setupI18n(): Promise<I18n> {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="i18n-locale"]')
  const locale = meta?.content || 'en'

  try {
    const translations = await import(`./locales/${locale}.json`)
    i18n.store(translations.default ?? translations)
  } catch (err) {
    console.warn(`[i18n] Could not load locale "${locale}":`, err)
  }

  i18n.defaultLocale = 'en'
  i18n.locale = locale
  i18n.enableFallback = true

  ;(window as Window & { I18n?: I18n }).I18n = i18n
  return i18n
}

export function t(key: string, opts?: Record<string, unknown>): string {
  return i18n.t(key, opts)
}
