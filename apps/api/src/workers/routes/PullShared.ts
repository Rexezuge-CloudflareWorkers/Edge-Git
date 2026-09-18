import type { Hono } from 'hono';
import { parsePositiveInt } from '@edge-git/shared/validation';

type PullApp = Hono<{ Bindings: Env; Variables: { AuthenticatedUserEmailAddress: string } }>;

function parsePullNumber(raw: string | undefined): number | null {
  return parsePositiveInt(raw ?? null);
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
