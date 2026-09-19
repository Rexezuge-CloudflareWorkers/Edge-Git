import type { Context } from 'hono';
import { ServiceError } from '@edge-git/backend-errors';
import { getBackendStrings } from '@edge-git/shared/i18n';
import { createRequestScope } from '@edge-git/backend-services/composition';
import { getRequestScope } from '@edge-git/backend-runtime/di';
import { toServiceStatus as toMappedStatus } from '@edge-git/backend-services/errors';
import { readJsonBody } from '../workers/routes/BodyParser';

type HonoContext = Context<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

/**
 * Template Method base for Hono route handlers (Otter `IBaseRoute` pattern).
 * Subclasses implement `handleRequest`; the base owns error mapping so
 * handlers stop duplicating `catch(()=>null)` / status-code switches and
 * private-repo existence hiding stays consistent.
 *
 * Backend `Message` stays English (translate display-side per Otter i18n
 * guidance); `getBackendStrings` is wired here so the shared backend locale
 * bundle is live code, not dead code.
 *
 * Shared statics (`getScope`, `readJson`, `parseLimit`, `toServiceStatus`,
 * `toSafeErrorMessage`, `toErrorResponse`) are the single source of truth;
 * `PublicViewerResolver` delegates to them so both stay consistent.
 */
abstract class BaseRoute {
  protected abstract handleRequest(c: HonoContext): Promise<Response>;

  public async handle(c: HonoContext): Promise<Response> {
    try {
      return await this.handleRequest(c);
    } catch (error) {
      return BaseRoute.toErrorResponse(c, error);
    }
  }

  /**
   * Single-scope resolution (Otter pattern). Prefers the per-request container
   * installed by `scopeMiddleware`; falls back to a fresh scope for call sites
   * outside middleware ordering (tests, git auth helpers).
   */
  public static getScope(c: { get(key: string): unknown; env: Env }): ReturnType<typeof createRequestScope> {
    try {
      return getRequestScope(c as never);
    } catch {
      return createRequestScope(c.env);
    }
  }

  /**
   * Strict JSON body reader. Distinguishes malformed JSON (`malformed: true`)
   * from a valid empty object — callers must return 400 on malformed instead
   * of collapsing to `{}` and surfacing a misleading `required` error.
   */
  public static async readJson<T>(c: HonoContext | Context): Promise<{ malformed: boolean; body: T }> {
    return readJsonBody<T>(c);
  }

  /**
   * Clamped `?limit=` parser. Returns `def` when missing/unparsable, clamped
   * to `[1, max]` otherwise.
   */
  public static parseLimit(url: string, def = 100, max = 100): number {
    try {
      const raw = new URL(url).searchParams.get('limit');
      const n = raw ? Number(raw) : def;
      if (!Number.isFinite(n)) return def;
      return Math.min(max, Math.max(1, Math.floor(n)));
    } catch {
      return def;
    }
  }

  public static toServiceStatus(error: unknown): 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 {
    return toMappedStatus(error);
  }

  /**
   * Mask internal details on 500: callers must use this instead of echoing
   * `error.message` directly, otherwise D1/DO internals leak to clients.
   */
  public static toSafeErrorMessage(error: unknown, fallback: string): string {
    const status = this.toServiceStatus(error);
    if (status === 500) return fallback;
    return error instanceof Error && error.message ? error.message : fallback;
  }

  public static toErrorResponse(c: HonoContext, error: unknown): Response {
    if (error instanceof ServiceError) {
      const code = error.getErrorCode();
      const body = {
        error: error.getErrorType(),
        message: error.getErrorMessage(),
      };
      return Response.json(body, { status: code });
    }
    // Untyped errors are masked as 500; log the cause server-side only.
    console.error('Unhandled route error', error instanceof Error ? error.message : error);
    const locale = this.resolveLocale(c);
    const strings = getBackendStrings(locale);
    return Response.json({ error: 'InternalError', message: strings.common.internalError }, { status: 500 });
  }

  private static resolveLocale(c: HonoContext): string {
    try {
      const header = c.req.header('Accept-Language');
      if (!header) return 'en';
      const first = header.split(',', 1)[0]?.split(';', 1)[0]?.trim();
      return first && first.length > 0 ? first : 'en';
    } catch {
      return 'en';
    }
  }

  protected json(c: HonoContext, data: unknown, status = 200): Response {
    return c.json(data, status as 200);
  }

  protected fail(message: string, status = 400): Response {
    return Response.json({ error: message }, { status });
  }
}

export { BaseRoute };
export type { HonoContext };
