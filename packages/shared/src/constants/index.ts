export const ZERO_OID = '0000000000000000000000000000000000000000';
export const DEFAULT_BRANCH = 'main';
export const GIT_AGENT = 'edge-git/0.1.0';
export const MAX_REF_NAME_LENGTH = 255;

export const GIT_SERVICES = ['git-upload-pack', 'git-receive-pack'] as const;
export type GitServiceName = (typeof GIT_SERVICES)[number];

export const DEMO_USER_EMAIL = 'demo@example.com';
export const SELF_WORKER_BASE_HOSTNAME = 'edge-git-internal';
