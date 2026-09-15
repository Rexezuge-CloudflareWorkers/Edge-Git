import type { BackendLocaleStrings } from '../BackendStrings';

const enStrings: BackendLocaleStrings = {
  common: {
    unauthorized: 'Authentication Required.',
    forbidden: 'Access Denied.',
  },
  repo: {
    notFound: 'Repository Not Found.',
    visibilityDenied: 'This Repository Is Private.',
    created: 'Repository {fullName} Created.',
    deleted: 'Repository Deleted.',
  },
  token: {
    created: 'Token Created. Copy It Now — It Will Not Be Shown Again.',
    revoked: 'Token Revoked.',
    limitReached: 'Maximum Of {max} Tokens Reached.',
  },
  issue: {
    created: 'Issue Created.',
  },
  git: {
    pushRejected: 'Push Rejected: {reason}.',
  },
};

export { enStrings };
