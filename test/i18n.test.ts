import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  BACKEND_STRINGS,
  SUPPORTED_BACKEND_LOCALES,
  canonicalizeBackendLocaleTag,
  formatBackendString,
  getBackendStrings,
  normalizeBackendLocale,
  resolveLocalizedStrings,
} from '@edge-git/shared/i18n';

// NOTE: `apps/web/src/i18n.ts` (+ `lib/locale.ts`) is not importable in this
// node unit-test env — it pulls `i18next`/`react-i18next` (web-only deps, not
// resolvable from the repo root) and a Vite `import.meta.glob` locale chunk
// map. Web `normalizeLanguage`/`detectInitialLanguage` are therefore covered
// indirectly here by invoking `pnpm run validate:locales` (parity of the web
// `en` + `zh-CN` bundles) below.

describe('backend strings (en)', () => {
  it('serves Title Case English strings', () => {
    const strings = getBackendStrings('en');
    expect(strings).toBe(BACKEND_STRINGS.en);
    expect(strings.repo.notFound).toBe('Repository Not Found.');
    expect(strings.token.limitReached).toContain('{max}');
    expect(strings.git.pushRejected).toContain('{reason}');
  });

  it('keeps locale bundles structurally identical', () => {
    expect(Object.keys(BACKEND_STRINGS.en).sort()).toEqual(Object.keys(BACKEND_STRINGS['zh-CN']).sort());
    expect(SUPPORTED_BACKEND_LOCALES).toEqual(['en', 'zh-CN']);
  });
});

describe('backend strings (zh-CN)', () => {
  it('serves Chinese strings with matching placeholders', () => {
    const strings = getBackendStrings('zh-CN');
    expect(strings.repo.notFound).toBe('仓库不存在。');
    expect(strings.token.limitReached).toContain('{max}');
    expect(strings.repo.created).toContain('{fullName}');
  });
});

describe('locale fallback', () => {
  it('falls back to en for unknown, empty, or missing locales', () => {
    for (const locale of ['de', 'en-US', 'fr-CA', '', null, undefined]) {
      expect(getBackendStrings(locale)).toBe(BACKEND_STRINGS.en);
    }
  });

  it('maps zh variants to zh-CN', () => {
    for (const locale of ['zh', 'zh_CN', 'ZH-cn']) {
      expect(getBackendStrings(locale)).toBe(BACKEND_STRINGS['zh-CN']);
    }
  });

  it('canonicalizes tags case- and separator-insensitively', () => {
    expect(canonicalizeBackendLocaleTag('zh_cn')).toBe('zh-CN');
    expect(canonicalizeBackendLocaleTag('ZH-CN')).toBe('zh-CN');
    expect(canonicalizeBackendLocaleTag(' en ')).toBe('en');
    expect(normalizeBackendLocale('pt')).toBe('en');
  });

  it('resolveLocalizedStrings prefers the primary locale, then the fallback', () => {
    expect(resolveLocalizedStrings('zh-CN')).toBe(BACKEND_STRINGS['zh-CN']);
    expect(resolveLocalizedStrings('de', 'zh-CN')).toBe(BACKEND_STRINGS['zh-CN']);
    expect(resolveLocalizedStrings(null, null)).toBe(BACKEND_STRINGS.en);
    expect(resolveLocalizedStrings('en')).toBe(BACKEND_STRINGS.en);
  });
});

describe('formatBackendString', () => {
  it('substitutes string and number placeholders', () => {
    expect(formatBackendString('Repository {fullName} Created.', { fullName: 'alice/demo' })).toBe('Repository alice/demo Created.');
    expect(formatBackendString('Maximum Of {max} Tokens Reached.', { max: 5 })).toBe('Maximum Of 5 Tokens Reached.');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(formatBackendString('Hello {name}.', {})).toBe('Hello {name}.');
    expect(formatBackendString('No vars here.')).toBe('No vars here.');
  });
});

describe('web locale bundles', () => {
  it('passes scripts/validate_locales.mjs (en + zh-CN parity)', () => {
    const output = execFileSync('node', ['scripts/validate_locales.mjs'], { encoding: 'utf-8' });
    expect(output).toContain('OK');
  });
});
