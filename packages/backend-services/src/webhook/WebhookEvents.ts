import type { RepoEventType } from '@edge-git/backend-data/dao';
import type { WebhookEventName } from '@edge-git/shared';
import { CryptoUtil } from '@edge-git/shared/utils';

const WEBHOOK_EVENTS: readonly WebhookEventName[] = [
  'push',
  'repository',
  'issues',
  'issue_comment',
  'pull_request',
  'pull_request_review',
  'fork',
  'star',
  'watch',
  'release',
  'project',
  'discussion',
  'discussion_comment',
  'wiki',
  'snippet',
  'ping',
];

const MAX_URL_LENGTH = 2048;
const URL_PREFIX_LENGTH = 30;
const SECRET_SUFFIX_LENGTH = 4;
const IPV4_HOST_PATTERN = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/;

function normalizeEvents(input: unknown): WebhookEventName[] {
  if (!Array.isArray(input)) throw new Error('events must be an array of event names');
  const seen = new Set<WebhookEventName>();
  for (const entry of input) {
    if (typeof entry !== 'string' || !(WEBHOOK_EVENTS as readonly string[]).includes(entry)) {
      throw new Error(`unsupported webhook event: ${typeof entry === 'string' ? entry : '?'}. Supported: ${WEBHOOK_EVENTS.join(', ')}`);
    }
    seen.add(entry as WebhookEventName);
  }
  if (seen.size === 0) throw new Error('events must include at least one event');
  return [...seen];
}

function mapRepoEventToWebhookEvent(type: RepoEventType): WebhookEventName | null {
  switch (type) {
    case 'push': {
      return 'push';
    }
    case 'repo_created': {
      return 'repository';
    }
    case 'issue_opened':
    case 'issue_closed':
    case 'issue_reopened': {
      return 'issues';
    }
    case 'issue_commented': {
      return 'issue_comment';
    }
    case 'pr_opened':
    case 'pr_closed':
    case 'pr_merged': {
      return 'pull_request';
    }
    case 'pr_reviewed':
    case 'pr_commented': {
      return 'pull_request_review';
    }
    case 'fork_created': {
      return 'fork';
    }
    case 'release_created':
    case 'release_published': {
      return 'release';
    }
    case 'project_created':
    case 'project_closed':
    case 'project_reopened': {
      return 'project';
    }
    case 'discussion_opened':
    case 'discussion_answered':
    case 'discussion_locked': {
      return 'discussion';
    }
    case 'discussion_commented': {
      return 'discussion_comment';
    }
    case 'wiki_created':
    case 'wiki_updated': {
      return 'wiki';
    }
    case 'snippet_created': {
      return 'snippet';
    }
    default: {
      return null;
    }
  }
}

function maskUrl(url: string): string {
  return url.length > URL_PREFIX_LENGTH ? `${url.slice(0, URL_PREFIX_LENGTH)}...` : url;
}

function secretSuffix(secret: string): string {
  return secret.slice(-SECRET_SUFFIX_LENGTH);
}

/**
 * Best-effort SSRF guard for outbound hook URLs. Rejects non-http(s)
 * schemes, over-long URLs, and literal loopback/link-local/private/metadata
 * hostnames. DNS-resolved private IPs are NOT covered (no resolver in the
 * request path) — documented on the route.
 */
function validateWebhookUrl(raw: string): void {
  if (typeof raw !== 'string' || raw.trim().length === 0) throw new Error('url is required');
  const url = raw.trim();
  if (url.length > MAX_URL_LENGTH) throw new Error(`url must be at most ${MAX_URL_LENGTH} characters`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('url must be a valid absolute URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('url must use http or https');
  if (parsed.username || parsed.password) throw new Error('url must not embed credentials');
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost')) {
    throw new Error('url must not target localhost');
  }
  const loopbackHosts = ['::1', '0.0.0.0'];
  if (loopbackHosts.includes(host) || host.startsWith('::ffff:127.')) throw new Error('url must not target a loopback address');
  const ipv4 = IPV4_HOST_PATTERN.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    const loopback = a === 127;
    const rfc1918 = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    const linkLocal = a === 169 && b === 254;
    const carrierGrade = a === 100 && b >= 64 && b <= 127;
    if (loopback || rfc1918 || linkLocal || carrierGrade || a === 0) throw new Error('url must not target a private or reserved address');
  }
}

function generateHookSecret(): string {
  // Unique per hook (32 random bytes, base64url). Never shared across hooks
  // and never derived from a generic platform key.
  return CryptoUtil.randomBase64Url(32);
}

async function signDelivery(secret: string, body: string): Promise<string> {
  return `sha256=${await CryptoUtil.hmacSha256Hex(body, secret)}`;
}

async function verifyDeliverySignature(secret: string, body: string, signature: string): Promise<boolean> {
  return signature === (await signDelivery(secret, body));
}

interface WebhookPayloadInput {
  event: string;
  fullName: string;
  actorEmail: string;
  eventId?: string | null;
  subjectType?: string | null;
  subjectNumber?: number | null;
  subjectOid?: string | null;
  title?: string | null;
  action?: string | null;
  extra?: Record<string, unknown>;
  processedAt: number;
}

function buildWebhookPayload(input: WebhookPayloadInput): Record<string, unknown> {
  return {
    event: input.event,
    repository: { full_name: input.fullName },
    sender: { email: input.actorEmail },
    ...(input.eventId && { delivery_source_id: input.eventId }),
    ...(input.subjectType && { subject_type: input.subjectType }),
    ...(input.subjectNumber !== undefined && input.subjectNumber !== null && { subject_number: input.subjectNumber }),
    ...(input.subjectOid && { subject_oid: input.subjectOid }),
    ...(input.title && { title: input.title.slice(0, 200) }),
    ...(input.action && { action: input.action }),
    ...input.extra,
    processed_at: input.processedAt,
  };
}

export {
  WEBHOOK_EVENTS,
  MAX_URL_LENGTH,
  URL_PREFIX_LENGTH,
  normalizeEvents,
  mapRepoEventToWebhookEvent,
  maskUrl,
  secretSuffix,
  validateWebhookUrl,
  generateHookSecret,
  signDelivery,
  verifyDeliverySignature,
  buildWebhookPayload,
};
export type { WebhookPayloadInput };
