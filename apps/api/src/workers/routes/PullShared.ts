import type { Hono } from 'hono';

type PullApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parsePullNumber(raw: string | undefined): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) return null;
  return parsed;
}

interface MergePreviewShape {
  baseOid?: string;
  headOid?: string;
  mergeBase?: string | null;
  alreadyMerged?: boolean;
  canFastForward?: boolean;
}

export { parsePullNumber };
export type { MergePreviewShape, PullApp };
