export function normalizePath(p: string): string {
  let path = p;
  if (!path) return '/';
  path = path.split('?', 1)[0].split('#', 1)[0];
  path = path.replaceAll('\\', '/');
  if (!path.startsWith('/')) path = `/${path}`;
  const out: string[] = [];
  for (const rawSeg of path.split('/')) {
    // No trimming: git paths are byte-exact — `" my file "` is distinct from
    // `"my file"`. Only skip empties / `.` and resolve `..` lexically.
    const seg = rawSeg;
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

const KNOWN_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST', 'EPERM', 'EACCES', 'EINVAL', 'EBUSY', 'ENOSPC', 'ENOTEMPTY']);

export class ErrorNormalizer {
  ensureErrCode(error: Error): ErrorWithCode {
    // Preserve codes already set by the underlying FS (dofs / isomorphic-git).
    const existing = (error as { code?: unknown }).code;
    if (typeof existing === 'string' && existing.length > 0) {
      const preserved = new ErrorWithCode(error.message, existing);
      const withPath = error as { path?: unknown; syscall?: unknown };
      if (typeof withPath.path === 'string') preserved.path = withPath.path;
      if (typeof withPath.syscall === 'string') preserved.syscall = withPath.syscall;
      return preserved;
    }
    const e = new ErrorWithCode(error.message);
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
