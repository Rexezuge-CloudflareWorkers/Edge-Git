import { LANGUAGE_STORAGE_KEY, SUPPORTED_LANGUAGES, canonicalizeLanguageTag, normalizeLanguage } from '../i18n';

/**
 * Normalize an arbitrary language tag to one of the supported language tags.
 * Unknown tags fall back to `en` (`zh` base → `zh-CN`, bare base → matching
 * supported tag when one exists). Canonicalization delegates to the single
 * `i18n` canonicalizer (no duplicated logic).
 */
export function normalizeLocale(tag: string | null | undefined): string {
  if (!tag || typeof tag !== 'string') return 'en';
  const canonical = canonicalizeLanguageTag(tag);
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(canonical)) return canonical;
  return normalizeLanguage(canonical);
}

/**
 * Resolve the active locale: explicit `lng` first, then the stored SPA
 * language, then the browser language, defaulting to `en`.
 */
export function resolveLocale(lng?: string | null): string {
  if (lng) return normalizeLocale(lng);
  try {
    const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored) return normalizeLocale(stored);
  } catch {
    // Ignore storage errors.
  }
  try {
    if (typeof navigator !== 'undefined' && navigator.language) return normalizeLocale(navigator.language);
  } catch {
    // Ignore and fall through.
  }
  return 'en';
}

export function formatDateLocale(date: Date, lng?: string | null, options?: Intl.DateTimeFormatOptions): string {
  return date.toLocaleDateString(resolveLocale(lng), options);
}
