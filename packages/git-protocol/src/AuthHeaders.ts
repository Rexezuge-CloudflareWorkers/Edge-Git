export function getBasicCredentials(req: Request): { username: string; password: string } | null {
  const header = req.headers.get('Authorization') || '';
  const match = /^Basic\s+(\S+)$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = atob(match[1]);
    const idx = decoded.indexOf(':');
    if (idx === -1) return { username: decoded, password: '' };
    const username = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);
    return { username, password };
  } catch {
    return null;
  }
}

export function getBearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization') || '';
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ? match[1].trim() : null;
}
