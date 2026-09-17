const MAX_SLUG = 100;

function isAlnum(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
}

// Linear-time slugify without regex: map runs of non-alphanumerics to a
// single hyphen, then trim edge hyphens. (Web tsconfig lib is ES2020, so no
// `replaceAll` types; the char loop also stays sonar-safe.)
function normalizeWikiSlug(raw: string): string {
  const lower = raw.trim().toLowerCase();
  let out = '';
  let lastWasHyphen = true;
  for (const ch of lower) {
    if (isAlnum(ch)) {
      out += ch;
      lastWasHyphen = false;
    } else if (!lastWasHyphen) {
      out += '-';
      lastWasHyphen = true;
    }
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out.slice(0, MAX_SLUG);
}

function isValidWikiSlug(slug: string): boolean {
  if (slug.length === 0 || slug.length > MAX_SLUG) return false;
  if (slug.startsWith('-') || slug.endsWith('-') || slug.includes('--')) return false;
  for (const ch of slug) {
    if (ch !== '-' && !isAlnum(ch)) return false;
  }
  return true;
}

function titleToSlug(title: string): string {
  const slug = normalizeWikiSlug(title);
  return slug.length > 0 ? slug : 'untitled';
}

export { normalizeWikiSlug, isValidWikiSlug, titleToSlug, MAX_SLUG };
