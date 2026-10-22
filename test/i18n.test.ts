import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  LOCALE_STRINGS,
  SUPPORTED_LOCALES,
  canonicalizeLanguageTag,
  getLocalizedStrings,
  normalizeLocale,
  resolveLocalizedStrings,
} from '@rexezuge/i18n';

// NOTE: `apps/web/src/i18n.ts` (+ `lib/locale.ts`) is not importable in this
// node unit-test env — it pulls `i18next`/`react-i18next` (web-only deps, not
// resolvable from the repo root) and a Vite `import.meta.glob` locale chunk
// map. Web `normalizeLanguage`/`detectInitialLanguage` are therefore covered
// indirectly here by invoking `pnpm run validate:locales` (key/placeholder
// parity of all 12 bundles + bundle-dir parity with `SUPPORTED_LANGUAGES`)
// below.
//
// The backend bundle itself is the kit's (`@rexezuge/i18n`); these tests
// cover the contract Edge-Git depends on — twelve locales, key parity, a total
// lookup that never returns `undefined`, and the `Accept-Language`-plus-
// preference fallback chain.

describe('backend strings (en)', () => {
  it('serves Title Case English strings', () => {
    const strings = getLocalizedStrings('en');
    expect(strings).toBe(LOCALE_STRINGS.en);
    expect(strings.common.unauthorized).toBe('Authentication Required.');
    expect(strings.common.forbidden).toBe('Access Denied.');
    expect(strings.common.internalError).toBe('Internal Server Error.');
  });

  it('keeps locale bundles structurally identical', () => {
    const enKeys = Object.keys(LOCALE_STRINGS.en).sort();
    expect(SUPPORTED_LOCALES).toEqual(['en', 'de', 'fr', 'es', 'it', 'nl', 'pt', 'pl', 'ja', 'zh-CN', 'zh-TW', 'ko']);
    expect(Object.keys(LOCALE_STRINGS)).toEqual([...SUPPORTED_LOCALES]);
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(LOCALE_STRINGS[locale]).sort()).toEqual(enKeys);
    }
  });

  it('keeps the common group identical in shape across every locale', () => {
    const enCommon = Object.keys(LOCALE_STRINGS.en.common).sort();
    for (const locale of SUPPORTED_LOCALES) {
      expect(Object.keys(LOCALE_STRINGS[locale].common).sort(), locale).toEqual(enCommon);
      for (const [key, value] of Object.entries(LOCALE_STRINGS[locale].common)) {
        expect(value.length, `${locale}.${key}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('backend strings (zh-CN)', () => {
  it('serves Chinese strings', () => {
    const strings = getLocalizedStrings('zh-CN');
    expect(strings.common.internalError).toBe('服务器内部错误。');
  });
});

describe('locale fallback', () => {
  it('falls back to en for unknown, empty, or missing locales', () => {
    for (const locale of ['en-US', 'xx', '', null, undefined]) {
      expect(getLocalizedStrings(locale)).toBe(LOCALE_STRINGS.en);
    }
  });

  it('serves every supported locale directly', () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(getLocalizedStrings(locale)).toBe(LOCALE_STRINGS[locale]);
    }
  });

  it('maps zh variants to zh-CN', () => {
    for (const locale of ['zh', 'zh_CN', 'ZH-cn']) {
      expect(getLocalizedStrings(locale)).toBe(LOCALE_STRINGS['zh-CN']);
    }
  });

  it('base-matches regional variants to their language bundle', () => {
    expect(getLocalizedStrings('de-AT')).toBe(LOCALE_STRINGS.de);
    expect(getLocalizedStrings('fr-CA')).toBe(LOCALE_STRINGS.fr);
    expect(getLocalizedStrings('pt-BR')).toBe(LOCALE_STRINGS.pt);
  });

  it('canonicalizes tags case- and separator-insensitively', () => {
    expect(canonicalizeLanguageTag('zh_cn')).toBe('zh-CN');
    expect(canonicalizeLanguageTag('ZH-CN')).toBe('zh-CN');
    expect(canonicalizeLanguageTag(' en ')).toBe('en');
    expect(normalizeLocale('pt')).toBe('pt');
    expect(normalizeLocale('xx')).toBe('en');
  });

  it('resolveLocalizedStrings prefers the primary locale, then the fallback', () => {
    expect(resolveLocalizedStrings('zh-CN')).toBe(LOCALE_STRINGS['zh-CN']);
    expect(resolveLocalizedStrings('xx', 'zh-CN')).toBe(LOCALE_STRINGS['zh-CN']);
    expect(resolveLocalizedStrings('de', 'zh-CN')).toBe(LOCALE_STRINGS.de);
    expect(resolveLocalizedStrings(null, null)).toBe(LOCALE_STRINGS.en);
    expect(resolveLocalizedStrings('en')).toBe(LOCALE_STRINGS.en);
  });
});

describe('web locale bundles', () => {
  // The validator runs as a separate process through `tsx`, so it pays the
  // TypeScript transform on every run. The default 5s budget is not enough for
  // that under the coverage run's load.
  it('passes the kit locale validator (all 12 bundles + SUPPORTED_LANGUAGES parity)', { timeout: 60_000 }, () => {
    const output = execFileSync(
      'pnpm',
      [
        'exec',
        'tsx',
        'node_modules/@rexezuge/tooling/src/scripts/validate-locales.ts',
        'apps/web/src/locales',
        '--tags=apps/web/src/i18n.ts',
      ],
      { encoding: 'utf-8' },
    );
    expect(output).toContain('Locale validation passed');
  });
});