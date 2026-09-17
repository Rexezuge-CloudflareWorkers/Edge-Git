import { DurableObject } from 'cloudflare:workers';
import { CheckRunDAO } from '@edge-git/backend-data/dao';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { parseCodeowners } from '@edge-git/backend-services/collab';
import { isBuiltInCheckContext, parseRequiredGlobs, runCodeownersStep, runDiffLimitStep, runRequiredFilesStep, runSecretScanStep } from '@edge-git/backend-services/checks';
import type { StepOutcome } from '@edge-git/backend-services/checks';
import { scanText } from '@edge-git/backend-services/security';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { TimestampUtil } from '@edge-git/shared/utils';
import { createLogger } from '@edge-git/backend-runtime/logger';

const logger = createLogger('CheckRunner');

interface EnqueueChecksInput {
  repositoryId: string;
  headSha: string;
  contexts: string[];
  actorEmail: string;
}

interface PendingItem extends EnqueueChecksInput {
  attempts: number;
}

interface RepoStubShape {
  listAllFiles(args: { ref?: string; maxFiles?: number }): Promise<Array<{ path: string; oid: string }>>;
  getBlob(args: { ref?: string; filepath: string }): Promise<{ contentBase64?: string; isBinary?: boolean } | null>;
  getCommitDiff(commitOid: string): Promise<{ files?: unknown[] } | null>;
}

interface IndexedBlob {
  contentBase64?: string;
  isBinary?: boolean;
}

const MAX_SCAN_FILES = 50;
const MAX_SCAN_BYTES = 20_000;
const MAX_ATTEMPTS = 3;
const CODEOWNERS_CANDIDATES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

function decodeBlobToText(blob: IndexedBlob | null): string | null {
  if (!blob?.contentBase64 || blob.isBinary) return null;
  try {
    const binary = atob(blob.contentBase64);
    if (binary.length > MAX_SCAN_BYTES) return null;
    const bytes = Uint8Array.from(binary, (c) => c.codePointAt(0) ?? 0);
    if (bytes.includes(0)) return null;
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

// CI check executor: one DO per repo (`CHECK_RUNNER.getByName(fullName)`).
// 30s CPU per invocation (vs 10ms in the Worker) fits deterministic built-in
// steps over the RepoWorker read-model. Arbitrary builds stay external via
// the PATCH check-run API (custom-js follow-up). Single-flight per repo comes
// free: only one alarm() runs at a time per object. D1 holds conclusions
// (source of truth for the merge gate); DO storage holds only the ephemeral
// pending queue. Never throws across RPC boundaries — failures mark runs
// completed with a visible conclusion instead of hanging them pending.
class CheckRunnerWorker extends DurableObject<Env> {
  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/enqueue' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as EnqueueChecksInput | null;
      if (!body || typeof body.repositoryId !== 'string' || typeof body.headSha !== 'string' || !Array.isArray(body.contexts)) {
        return Response.json({ error: 'repositoryId, headSha, and contexts are required' }, { status: 400 });
      }
      await this.enqueueChecks(body);
      return Response.json({ ok: true });
    }
    return new Response('Not Found', { status: 404 });
  }

  public async enqueueChecks(input: EnqueueChecksInput): Promise<{ queued: number }> {
    const contexts = [...new Set(input.contexts.map((c) => c.trim()).filter((c) => c.length > 0))].slice(0, 50);
    if (contexts.length === 0) return { queued: 0 };
    const pending = ((await this.ctx.storage.get<PendingItem[]>('pending')) ?? []).filter((p) => p.headSha !== input.headSha || p.repositoryId !== input.repositoryId);
    pending.push({ repositoryId: input.repositoryId, headSha: input.headSha.toLowerCase(), contexts, actorEmail: input.actorEmail, attempts: 0 });
    await this.ctx.storage.put('pending', pending.slice(-20));
    await this.ctx.storage.setAlarm(Date.now() + 1000).catch(() => undefined);
    return { queued: contexts.length };
  }

  public override async alarm(): Promise<void> {
    const pending = (await this.ctx.storage.get<PendingItem[]>('pending').catch(() => null)) ?? [];
    if (pending.length === 0) return;
    await this.ctx.storage.put('pending', []);
    for (const item of pending) {
      try {
        await this.processItem(item);
      } catch (error) {
        logger.error('CheckRunner: failed to process enqueue', error);
        if (item.attempts < MAX_ATTEMPTS) {
          const rest = ((await this.ctx.storage.get<PendingItem[]>('pending')) ?? []).slice(-19);
          rest.push({ ...item, attempts: item.attempts + 1 });
          await this.ctx.storage.put('pending', rest).catch(() => undefined);
          await this.ctx.storage.setAlarm(Date.now() + 30_000).catch(() => undefined);
        }
      }
    }
  }

  private async processItem(item: PendingItem): Promise<void> {
    const dao = new CheckRunDAO(this.env.DB);
    const fullName = await this.resolveFullName(item.repositoryId);
    const repoStub = this.env.REPO.getByName(fullName ?? item.repositoryId) as unknown as RepoStubShape;
    for (const context of item.contexts) {
      const base = context.split(':', 1)[0] ?? context;
      if (!isBuiltInCheckContext(base)) continue;
      let run = await dao.getByRepoShaContext(item.repositoryId, item.headSha, context).catch(() => null);
      if (!run) {
        // Auto-create the queued row for required built-ins so pushes do not
        // depend on the API caller pre-reporting every context.
        try {
          const { UUIDUtil } = await import('@edge-git/shared/utils');
          const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
          await dao.create({ id: UUIDUtil.getRandomUUID(), repositoryId: item.repositoryId, headSha: item.headSha, context, creatorEmail: item.actorEmail, now });
          run = await dao.getByRepoShaContext(item.repositoryId, item.headSha, context).catch(() => null);
        } catch {
          continue;
        }
      }
      if (!run || run.status === 'completed') continue;
      await this.executeBuiltIn(dao, repoStub, item, run.id, context);
    }
  }

  private async executeBuiltIn(
    dao: CheckRunDAO,
    repoStub: RepoStubShape,
    item: PendingItem,
    runId: string,
    context: string,
  ): Promise<void> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await dao.updateStatus(runId, item.repositoryId, { status: 'in_progress', conclusion: null, now, completedAt: null }).catch(() => undefined);
    const [base, arg] = context.split(/:(.*)/).map((s) => s?.trim() ?? '');
    try {
      const step = await this.runStep(repoStub, item.headSha, base ?? context, arg ?? '');
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
      await this.emitCheckCompleted(item, runId, context, step.conclusion, step.title).catch(() => undefined);
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

  private async runStep(
    repoStub: RepoStubShape,
    headSha: string,
    base: string,
    arg: string,
  ): Promise<StepOutcome> {
    switch (base) {
      case 'secret-scan': {
        const files = await repoStub.listAllFiles({ ref: headSha, maxFiles: MAX_SCAN_FILES }).catch(() => []);
        const findings = new Map<string, string>();
        for (const file of files.slice(0, MAX_SCAN_FILES)) {
          const blob = await repoStub.getBlob({ ref: headSha, filepath: file.path }).catch(() => null);
          const text = decodeBlobToText(blob);
          if (text === null) continue;
          for (const finding of scanText(text)) findings.set(finding.ruleId, finding.hint);
          if (findings.size >= 10) break;
        }
        return runSecretScanStep([...findings].map(([ruleId, hint]) => ({ ruleId, hint })));
      }
      case 'diff-limit': {
        const maxFiles = ConfigurationManager.repo.getMaxMergeDiffFiles(this.env);
        const diff = await repoStub.getCommitDiff(headSha).catch(() => null);
        const count = Array.isArray(diff?.files) ? diff.files.length : 0;
        return runDiffLimitStep(count, maxFiles);
      }
      case 'codeowners-exists': {
        for (const candidate of CODEOWNERS_CANDIDATES) {
          const blob = await repoStub.getBlob({ ref: headSha, filepath: candidate }).catch(() => null);
          const text = decodeBlobToText(blob);
          if (text === null) continue;
          return runCodeownersStep({ content: text, ruleCount: parseCodeowners(text).length });
        }
        return runCodeownersStep({ content: null, ruleCount: 0 });
      }
      case 'required-files': {
        const required = parseRequiredGlobs(arg);
        const patterns = required.length > 0 ? required : ['README.md'];
        const files = await repoStub.listAllFiles({ ref: headSha, maxFiles: 500 }).catch(() => []);
        return runRequiredFilesStep(files.map((f) => f.path), patterns);
      }
      default: {
        return { conclusion: 'neutral', title: 'Unknown Check', summary: `No built-in step for ${base}.` };
      }
    }
  }

  private async resolveFullName(repositoryId: string): Promise<string | null> {
    try {
      const scope = createRequestScope(this.env);
      const dao = await scope.get(Tokens.RepositoryDAO)();
      const row = await dao.getById(repositoryId);
      return row ? `${row.owner}/${row.name}` : null;
    } catch {
      return null;
    }
  }

  private async emitCheckCompleted(
    item: PendingItem,
    runId: string,
    context: string,
    conclusion: string,
    title: string,
  ): Promise<void> {
    const fullName = await this.resolveFullName(item.repositoryId);
    if (!fullName) return;
    await createRequestScope(this.env)
      .get(Tokens.WebhookDeliveryService)
      .enqueueForEvent({
        repositoryId: item.repositoryId,
        fullName,
        event: 'check_run',
        actorEmail: item.actorEmail,
        subjectOid: item.headSha,
        title: `${context}: ${conclusion}`,
        action: 'completed',
        extra: { check_run_id: runId, context, conclusion, title },
      })
      .catch(() => undefined);
  }
}

export { CheckRunnerWorker };
export type { EnqueueChecksInput };
