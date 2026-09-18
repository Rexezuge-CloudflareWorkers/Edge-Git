import { ServiceError } from '@edge-git/backend-errors';
import { getBackendStrings } from '@edge-git/shared/i18n';

interface MappedError {
  status: number;
  body: { error: string; message: string };
}

// Central error mapper (DIP): routes and DO handlers convert domain errors
// here instead of duplicating `instanceof ServiceError` switches or
// `.catch(()=>null)` existence-hiding. Private-resource hiding stays explicit
// via `hideExistence`.
function mapServiceError(error: unknown, locale?: string | null): MappedError {
  if (error instanceof ServiceError) {
    return {
      status: error.getErrorCode(),
      body: { error: error.getErrorType(), message: error.getErrorMessage() },
    };
  }
  const strings = getBackendStrings(locale ?? 'en');
  return { status: 500, body: { error: 'InternalError', message: strings.common.internalError } };
}

function toServiceStatus(error: unknown): 400 | 403 | 404 | 500 {
  const mapped = mapServiceError(error);
  if ([400, 403, 404].includes(mapped.status)) return mapped.status as 400 | 403 | 404;
  return 500;
}

// Existence-hiding policy: private/missing resources map to null (caller → 404/401).
async function hideExistence<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export { mapServiceError, toServiceStatus, hideExistence };
export type { MappedError };
