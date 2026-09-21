export function splitRepo(value: string): { owner: string; repo: string } | null {
  const trimmed = value.trim().replace(/\.git$/, '');
  const parts = trimmed.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}
