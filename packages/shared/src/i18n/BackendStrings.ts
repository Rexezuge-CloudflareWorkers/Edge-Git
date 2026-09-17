const SUPPORTED_BACKEND_LOCALES = ['en', 'zh-CN'] as const;

type SupportedBackendLocale = (typeof SUPPORTED_BACKEND_LOCALES)[number];

interface CommonStrings {
  unauthorized: string;
  forbidden: string;
}

interface RepoStrings {
  notFound: string;
  visibilityDenied: string;
  created: string;
  deleted: string;
}

interface TokenStrings {
  created: string;
  revoked: string;
  limitReached: string;
}

interface IssueStrings {
  created: string;
}

interface GitStrings {
  pushRejected: string;
}

interface NamespaceStrings {
  reserved: string;
}

interface BackendLocaleStrings {
  common: CommonStrings;
  repo: RepoStrings;
  token: TokenStrings;
  issue: IssueStrings;
  git: GitStrings;
  namespace: NamespaceStrings;
}

function formatBackendString(template: string, vars: Record<string, string | number> = {}): string {
  return template.replaceAll(/\{(\w+)\}/g, (match: string, key: string): string => {
    const value: unknown = vars[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : match;
  });
}

function canonicalizeBackendLocaleTag(tag: string): string {
  const normalized = tag.trim().replaceAll('_', '-');
  const parts = normalized.split('-').filter(Boolean);
  if (parts.length === 0) return 'en';
  const language = (parts[0] ?? 'en').toLowerCase();
  if (parts.length === 1) return language;
  const rest = parts.slice(1).map((part) => (part.length === 2 ? part.toUpperCase() : part.toLowerCase()));
  return [language, ...rest].join('-');
}

function normalizeBackendLocale(locale: string | null | undefined): SupportedBackendLocale {
  if (!locale || typeof locale !== 'string') return 'en';
  const canonical = canonicalizeBackendLocaleTag(locale);
  if ((SUPPORTED_BACKEND_LOCALES as readonly string[]).includes(canonical)) {
    return canonical as SupportedBackendLocale;
  }
  const base = canonical.split('-', 1)[0]?.toLowerCase() ?? 'en';
  if (base === 'zh') return 'zh-CN';
  return 'en';
}

export type {
  BackendLocaleStrings,
  CommonStrings,
  RepoStrings,
  TokenStrings,
  IssueStrings,
  GitStrings,
  NamespaceStrings,
  SupportedBackendLocale,
};
export { SUPPORTED_BACKEND_LOCALES, canonicalizeBackendLocaleTag, formatBackendString, normalizeBackendLocale };
