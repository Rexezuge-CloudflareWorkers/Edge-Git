import type { Context, Next } from 'hono';

type HeaderContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// Paths carrying bearer secrets — never allow caching of their responses.
function isSensitiveJsonPath(pathname: string): boolean {
  return (
    pathname.includes('/user/tokens') ||
    pathname.includes('/hooks') ||
    pathname.includes('/realtime/ticket') ||
    pathname.includes('/realtime/inbox-ticket')
  );
}

/**
 * Baseline security headers for API JSON responses and the SPA shell.
 * The SPA needs inline scripts/styles, so CSP stays permissive-but-bounded
 * (`frame-ancestors 'none'` blocks clickjacking without breaking Vite).
 */
function applySecurityHeaders(c: HeaderContext): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    c.header(key, value);
  }
  const contentType = c.res.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    c.header(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'",
    );
  }
  // Bearer-secret JSON (PATs, hook secrets, realtime tickets) must never be
  // cached by browsers or CDNs.
  try {
    const pathname = new URL(c.req.url).pathname;
    if (isSensitiveJsonPath(pathname)) {
      c.header('Cache-Control', 'no-store');
    }
  } catch {
    // URL parsing must never fail the request.
  }
  // HSTS only makes sense over HTTPS; harmless locally, enforced in prod.
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

function securityHeaders(): (c: HeaderContext, next: Next) => Promise<Response | void> {
  // eslint-disable-next-line unicorn/consistent-function-scoping
  return async (c: HeaderContext, next: Next): Promise<Response | void> => {
    await next();
    try {
      applySecurityHeaders(c);
    } catch {
      // Headers must never fail the request.
    }
  };
}

export { securityHeaders, SECURITY_HEADERS, isSensitiveJsonPath, applySecurityHeaders };
