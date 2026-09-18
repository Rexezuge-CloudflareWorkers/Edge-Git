import { z } from 'zod';
import { OWNER_PATTERN, REPO_PATTERN } from '../utils/Identity';

const usernameSchema = z.string().trim().min(1).max(39).regex(OWNER_PATTERN, 'Invalid username');

const teamSlugSchema = z.string().trim().min(1).max(39).regex(OWNER_PATTERN, 'Invalid team slug');

const repoNameSchema = z.string().trim().min(1).max(100).regex(REPO_PATTERN, 'Invalid repository name');

// Control characters are rejected via code points (not a regex) so the
// `no-control-regex` lint rule stays satisfied.
function hasNoControlChars(name: string): boolean {
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x7f || code <= 0x1f) return false;
  }
  return true;
}

const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('..'), 'Invalid branch name')
  .refine((name) => !name.includes('//'), 'Invalid branch name')
  .refine((name) => !name.includes('\0'), 'Invalid branch name')
  .refine(
    (name) => !name.endsWith('.') && !name.endsWith('/') && !name.endsWith('.lock'),
    'Invalid branch name',
  )
  .refine((name) => !/[\s~^:?*[\]@{\\]/.test(name) && hasNoControlChars(name), 'Invalid branch name')
  .refine(
    (name) => name.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && seg !== '@'),
    'Invalid branch name',
  );

const assetNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (name) =>
      !name.includes('..') &&
      !name.includes('/') &&
      !name.includes('\\') &&
      !name.includes('\0') &&
      name !== '.git' &&
      !name.startsWith('.git/'),
    'Invalid asset name',
  );

export { usernameSchema, teamSlugSchema, repoNameSchema, branchNameSchema, assetNameSchema };
