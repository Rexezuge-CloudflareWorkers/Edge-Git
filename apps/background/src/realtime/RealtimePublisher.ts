import { buildEnvelope, inboxTagForHash, isChannel } from '@edge-git/shared/realtime';
import type { RealtimeEnvelope } from '@edge-git/shared/realtime';
import { TimestampUtil, UUIDUtil } from '@edge-git/shared/utils';

interface PublishInput {
  channel: string;
  type: string;
  actor?: string;
  title?: string;
  subjectType?: string | null;
  subjectNumber?: number | null;
  sha?: string | null;
  extra?: Record<string, unknown>;
  recipientHashes?: string[];
}

function buildChannelEnvelope(input: PublishInput, channel: string): RealtimeEnvelope | null {
  return buildEnvelope({
    id: UUIDUtil.getRandomUUID(),
    ts: TimestampUtil.getCurrentUnixTimestampInSeconds(),
    channel,
    type: input.type,
    actor: typeof input.actor === 'string' ? input.actor : '',
    title: typeof input.title === 'string' ? input.title : '',
    subjectType: input.subjectType,
    subjectNumber: input.subjectNumber,
    sha: input.sha,
    extra: input.extra,
  });
}

function inboxTagsFor(input: PublishInput, cap = 500): string[] {
  const hashes = Array.isArray(input.recipientHashes) ? input.recipientHashes : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const hash of hashes) {
    if (typeof hash !== 'string' || seen.has(hash)) continue;
    seen.add(hash);
    if (seen.size > cap) break;
    const tag = inboxTagForHash(hash);
    if (isChannel(tag)) tags.push(tag);
  }
  return tags;
}

export { buildChannelEnvelope, inboxTagsFor };
export type { PublishInput };
