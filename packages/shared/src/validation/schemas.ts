import { z } from 'zod';
import { OWNER_PATTERN, REPO_PATTERN } from '../utils/Identity';

const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(OWNER_PATTERN, 'Invalid username');

const teamSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(OWNER_PATTERN, 'Invalid team slug');

const repoNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(REPO_PATTERN, 'Invalid repository name');

const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('..') && !name.includes('\0'), 'Invalid branch name');

const assetNameSchema = z.string().trim().min(1).max(255);

export { usernameSchema, teamSlugSchema, repoNameSchema, branchNameSchema, assetNameSchema };
