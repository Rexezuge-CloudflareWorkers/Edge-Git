import type { Hono } from 'hono';
import { parsePositiveInt } from '@edge-git/shared/validation';

type ProjectApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parseProjectNumber(raw: string | undefined): number | null {
  return parsePositiveInt(raw ?? null);
}

export { parseProjectNumber };
export type { ProjectApp };
