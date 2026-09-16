import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { NotificationService } from '@edge-git/backend-services/social/NotificationService';
import type { RepoEventType } from '@edge-git/backend-data/dao';

interface SocialEmitInput {
  repositoryId: string;
  fullName: string;
  actorEmail: string;
  type: RepoEventType;
  title: string;
  subjectType?: string | null;
  subjectNumber?: number | null;
  subjectOid?: string | null;
  payload?: Record<string, unknown>;
  participantEmails?: string[];
  mentionText?: string | null;
}

// Best-effort activity + notification fan-out for issue/PR/fork/push flows.
// Never throws: social writes must not fail the user-visible mutation.
async function recordAndNotify(env: Env, input: SocialEmitInput): Promise<void> {
  const scope = createRequestScope(env);
  try {
    await scope.get(Tokens.ActivityService).record({
      repositoryId: input.repositoryId,
      fullName: input.fullName,
      actorEmail: input.actorEmail,
      type: input.type,
      subjectType: input.subjectType ?? null,
      subjectNumber: input.subjectNumber ?? null,
      subjectOid: input.subjectOid ?? null,
      payload: input.payload ?? {},
    });
  } catch (error) {
    console.error('Failed to record repo event', input.type, input.fullName, error);
  }
  try {
    const mentionUsernames = NotificationService.parseMentions(input.mentionText ?? input.title);
    await scope.get(Tokens.NotificationService).fanOut({
      repositoryId: input.repositoryId,
      fullName: input.fullName,
      actorEmail: input.actorEmail,
      type: input.type,
      title: input.title,
      subjectType: input.subjectType ?? null,
      subjectNumber: input.subjectNumber ?? null,
      participantEmails: input.participantEmails ?? [],
      mentionUsernames,
    });
  } catch (error) {
    console.error('Failed to fan out notifications', input.type, input.fullName, error);
  }
  try {
    await scope.get(Tokens.WatchService).ensureWatching(input.repositoryId, input.actorEmail);
  } catch {
    // auto-watch is a nicety; ignore
  }
}

export { recordAndNotify };
export type { SocialEmitInput };
