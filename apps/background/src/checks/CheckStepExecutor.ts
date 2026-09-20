import type { CheckRunDAO } from '@edge-git/backend-data/dao';
import { parseCodeowners } from '@edge-git/backend-services/collab';
import {
  parseRequiredGlobs,
  runCodeownersStep,
  runDiffLimitStep,
  runRequiredFilesStep,
  runSecretScanStep,
} from '@edge-git/backend-services/checks';
import type { StepOutcome } from '@edge-git/backend-services/checks';
import { scanText } from '@edge-git/backend-services/security';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { TimestampUtil } from '@edge-git/shared/utils';
import { decodeBlobToText } from './CheckDefinition';

interface RepoStubShape {
  listAllFiles(args: { ref?: string; maxFiles?: number }): Promise<Array<{ path: string; oid: string }>>;
  getBlob(args: { ref?: string; filepath: string }): Promise<{ contentBase64?: string; isBinary?: boolean } | null>;
  getCommitDiff(commitOid: string): Promise<{ files?: unknown[] } | null>;
}

interface PendingItemShape {
  repositoryId: string;
  headSha: string;
  actorEmail: string;
}

const MAX_SCAN_FILES = 50;
const MAX_SCAN_BYTES = 20_000;
const CODEOWNERS_CANDIDATES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

// Built-in deterministic step executor (Strategy pattern): one pure branch
// per `base` context. Extracted from CheckRunnerWorker so the DO stays a
// thin queue/routing facade under the god-file guard.
async function preloadTextFiles(repoStub: RepoStubShape, headSha: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const listed = await repoStub.listAllFiles({ ref: headSha, maxFiles: 500 }).catch(() => []);
  for (const file of listed.slice(0, MAX_SCAN_FILES)) {
    if (Object.keys(files).length >= MAX_SCAN_FILES) break;
    const blob = await repoStub.getBlob({ ref: headSha, filepath: file.path }).catch(() => null);
    const text = decodeBlobToText(blob, MAX_SCAN_BYTES);
    if (text !== null) files[file.path] = text;
  }
  return files;
}

async function runBuiltInStep(env: Env, repoStub: RepoStubShape, headSha: string, base: string, arg: string): Promise<StepOutcome> {
  switch (base) {
    case 'secret-scan': {
      const files = await repoStub.listAllFiles({ ref: headSha, maxFiles: MAX_SCAN_FILES }).catch(() => []);
      const findings = new Map<string, string>();
      for (const file of files.slice(0, MAX_SCAN_FILES)) {
        const blob = await repoStub.getBlob({ ref: headSha, filepath: file.path }).catch(() => null);
        const text = decodeBlobToText(blob, MAX_SCAN_BYTES);
        if (text === null) continue;
        for (const finding of scanText(text)) findings.set(finding.ruleId, finding.hint);
        if (findings.size >= 10) break;
      }
      return runSecretScanStep([...findings].map(([ruleId, hint]) => ({ ruleId, hint })));
    }
    case 'diff-limit': {
      const maxFiles = ConfigurationManager.repo.getMaxMergeDiffFiles(env);
      const diff = await repoStub.getCommitDiff(headSha).catch(() => null);
      const count = Array.isArray(diff?.files) ? diff.files.length : 0;
      return runDiffLimitStep(count, maxFiles);
    }
    case 'codeowners-exists': {
      for (const candidate of CODEOWNERS_CANDIDATES) {
        const blob = await repoStub.getBlob({ ref: headSha, filepath: candidate }).catch(() => null);
        const text = decodeBlobToText(blob, MAX_SCAN_BYTES);
        if (text === null) continue;
        return runCodeownersStep({ content: text, ruleCount: parseCodeowners(text).length });
      }
      return runCodeownersStep({ content: null, ruleCount: 0 });
    }
    case 'required-files': {
      const required = parseRequiredGlobs(arg);
      const patterns = required.length > 0 ? required : ['README.md'];
      const files = await repoStub.listAllFiles({ ref: headSha, maxFiles: 500 }).catch(() => []);
      return runRequiredFilesStep(
        files.map((f) => f.path),
        patterns,
      );
    }
    default: {
      return { conclusion: 'neutral', title: 'Unknown Check', summary: `No built-in step for ${base}.` };
    }
  }
}

async function executeBuiltInStep(
  env: Env,
  dao: CheckRunDAO,
  repoStub: RepoStubShape,
  item: PendingItemShape,
  runId: string,
  context: string,
  emit: (runId: string, conclusion: string, title: string) => Promise<void>,
): Promise<void> {
  const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
  await dao
    .updateStatus(runId, item.repositoryId, { status: 'in_progress', conclusion: null, now, completedAt: null })
    .catch(() => undefined);
  const [base, arg] = context.split(/:(.*)/).map((s) => s?.trim() ?? '');
  try {
    const step = await runBuiltInStep(env, repoStub, item.headSha, base ?? context, arg ?? '');
    const done = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await dao
      .updateStatus(runId, item.repositoryId, {
        status: 'completed',
        conclusion: step.conclusion,
        outputTitle: step.title,
        outputSummary: step.summary,
        now: done,
        completedAt: done,
      })
      .catch(() => undefined);
    await emit(runId, step.conclusion, step.title).catch(() => undefined);
  } catch (error) {
    const done = TimestampUtil.getCurrentUnixTimestampInSeconds();
    const message = error instanceof Error ? error.message.slice(0, 500) : 'Check execution failed.';
    await dao
      .updateStatus(runId, item.repositoryId, {
        status: 'completed',
        conclusion: 'action_required',
        outputTitle: 'Check Error',
        outputSummary: message,
        now: done,
        completedAt: done,
      })
      .catch(() => undefined);
  }
}

export { CODEOWNERS_CANDIDATES, MAX_SCAN_BYTES, MAX_SCAN_FILES, executeBuiltInStep, preloadTextFiles, runBuiltInStep };
export type { PendingItemShape, RepoStubShape };
