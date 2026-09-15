export function normalizePath(p: string): string {
  let path = p;
  if (!path) return '/';
  path = path.split('?', 1)[0].split('#', 1)[0];
  path = path.replaceAll('\\', '/');
  if (!path.startsWith('/')) path = `/${path}`;
  const out: string[] = [];
  for (const rawSeg of path.split('/')) {
    const seg = rawSeg.trim();
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join('/')}`;
}

export class ErrorWithCode extends Error {
  code?: string;
  path?: string;
  syscall?: string;
  constructor(message: string, code?: string, path?: string, syscall?: string) {
    super(message);
    this.code = code;
    this.path = path;
    this.syscall = syscall;
  }
}

const KNOWN_CODES = new Set([
  'ENOENT',
  'ENOTDIR',
  'EISDIR',
  'EEXIST',
  'EPERM',
  'EACCES',
  'EINVAL',
  'EBUSY',
  'ENOSPC',
  'ENOTEMPTY',
]);

export class ErrorNormalizer {
  ensureErrCode(error: Error): ErrorWithCode {
    const e = new ErrorWithCode(error.message);
    if ((e as { code?: string }).code) return e;
    const msg = e.message.trim();
    if (KNOWN_CODES.has(msg)) {
      e.code = msg;
      return e;
    }
    const parts = msg.replaceAll(':', ' ').split(' ');
    for (const part of parts) {
      if (KNOWN_CODES.has(part)) {
        e.code = part;
        return e;
      }
    }
    if (!e.code) e.code = 'ENOENT';
    return e;
  }

  annotateAndThrow(error: unknown, syscall: string, path: string): never {
    if (error instanceof Error) {
      const e = this.ensureErrCode(error);
      e.path = path;
      e.syscall = syscall;
      throw e;
    }
    throw error;
  }

  annotateAndReject(error: unknown, syscall: string, path: string): Promise<never> {
    try {
      this.annotateAndThrow(error, syscall, path);
    } catch (annotated) {
      return Promise.reject(annotated instanceof Error ? annotated : new Error(String(annotated)));
    }
    throw error;
  }
}
