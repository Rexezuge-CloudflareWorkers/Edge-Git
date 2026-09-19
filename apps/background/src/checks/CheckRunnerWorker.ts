import { DurableObject } from 'cloudflare:workers';
import type { CheckRunDAO } from '@edge-git/backend-data/dao';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { parseCodeowners } from '@edge-git/backend-services/collab';
import {
  isBuiltInCheckContext,
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
import { createLogger } from '@edge-git/backend-runtime/logger';
import { decodeBlobToText, loadCheckDefinition, loadCheckScript } from './CheckDefinition';
import type { CustomCheckDefinition, LoadedDefinition } from './CheckDefinition';
import { runCustomCheckScript } from './CustomJsSandbox';
import { publishCheckLive } from './CheckLivePublish';

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

const MAX_SCAN_FILES = 50;
const MAX_SCAN_BYTES = 20_000;
const MAX_ATTEMPTS = 3;
const CODEOWNERS_CANDIDATES = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

// CI check executor: one DO per repo (`CHECK_RUNNER.getByName(fullName)`).
// 30s CPU per invocation (vs 10ms in the Worker) fits deterministic built-in
// steps plus sandboxed repo-defined custom-js steps over the RepoWorker
// read-model. Arbitrary builds stay external via the PATCH check-run API.
// Single-flight per repo comes free: only one alarm() runs at a time per
// object. D1 holds conclusions (source of truth for the merge gate); DO
// storage holds only the ephemeral pending queue. Never throws across RPC
// boundaries — failures mark runs completed with a visible conclusion
// instead of hanging them pending.
class CheckRunnerWorker extends DurableObject<Env> {
  public override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/enqueue' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as EnqueueChecksInput | null;
      if (!body || typeof body.repositoryId !== 'string' || typeof body.headSha !== 'string' || !Array.isArray(body.contexts)) {
        return Response.json(
          { Exception: { Type: 'BadRequest', Message: 'repositoryId, headSha, and contexts are required.' } },
          { status: 400 },
        );
      }
      await this.enqueueChecks(body);
      return Response.json({ ok: true });
    }
    return new Response('Not Found', { status: 404 });
  }

  public async enqueueChecks(input: EnqueueChecksInput): Promise<{ queued: number }> {
    const contexts = [...new Set(input.contexts.map((c) => c.trim()).filter((c) => c.length > 0))].slice(0, 50);
    if (contexts.length === 0) return { queued: 0 };
    const pending = ((await this.ctx.storage.get<PendingItem[]>('pending')) ?? []).filter(
      (p) => p.headSha !== input.headSha || p.repositoryId !== input.repositoryId,
    );
    pending.push({
      repositoryId: input.repositoryId,
      headSha: input.headSha.toLowerCase(),
      contexts,
      actorEmail: input.actorEmail,
      attempts: 0,
    });
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
    // Composition root (never `new XDAO(env.DB)` inline per AGENTS).
    const dao = await createRequestScope(this.env as never).get(Tokens.CheckRunDAO)();
    const fullName = await this.resolveFullName(item.repositoryId);
    const repoStub = this.env.REPO.getByName(fullName ?? item.repositoryId) as unknown as RepoStubShape;
    // Definitions load once per batch; absent means every custom context in
    // this item stays queued for external runners.
    let definition: LoadedDefinition | null = null;
    for (const context of item.contexts) {
      const base = context.split(':', 1)[0] ?? context;
      if (!isBuiltInCheckContext(base)) {
        if (definition === null) definition = await loadCheckDefinition(repoStub, item.headSha).catch(() => ({ state: 'absent' as const }));
        await this.processCustomContext(dao, repoStub, item, context, definition);
        continue;
      }
      let run = await dao.getByRepoShaContext(item.repositoryId, item.headSha, context).catch(() => null);
      if (!run) {
        // Auto-create the queued row for required built-ins so pushes do not
        // depend on the API caller pre-reporting every context.
        try {
          const { UUIDUtil } = await import('@edge-git/shared/utils');
          const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
          await dao.create({
            id: UUIDUtil.getRandomUUID(),
            repositoryId: item.repositoryId,
            headSha: item.headSha,
            context,
            creatorEmail: item.actorEmail,
            now,
          });
          run = await dao.getByRepoShaContext(item.repositoryId, item.headSha, context).catch(() => null);
        } catch {
          continue;
        }
      }
      if (!run || run.status === 'completed') continue;
      await this.executeBuiltIn(dao, repoStub, item, run.id, context);
    }
  }

  // Custom contexts resolve against `.edgegit/checks.json` at the head SHA.
  // No file (or no entry, or custom-js disabled) leaves the run queued for
  // external runners; a broken file or script marks action_required visibly
  // instead of hanging the merge gate on pending.
  private async processCustomContext(
    dao: CheckRunDAO,
    repoStub: RepoStubShape,
    item: PendingItem,
    context: string,
    definition: LoadedDefinition,
  ): Promise<void> {
    if (definition.state === 'absent') return;
    if (definition.state === 'error') {
      await this.completeCustom(dao, item, context, null, {
        conclusion: 'action_required',
        title: 'Invalid Check Definition',
        summary: definition.message,
      });
      return;
    }
    const entry = definition.checks.find((c) => c.context.toLowerCase() === context.toLowerCase()) ?? null;
    if (!entry) return;
    if (!ConfigurationManager.checks.isCustomJsEnabled(this.env)) return;
    await this.executeCustom(dao, repoStub, item, context, entry);
  }

  private async completeCustom(
    dao: CheckRunDAO,
    item: PendingItem,
    context: string,
    runId: string | null,
    step: { conclusion: 'success' | 'failure' | 'neutral' | 'skipped' | 'timed_out' | 'action_required'; title: string; summary: string },
  ): Promise<void> {
    let id = runId;
    if (!id) {
      const existing = await dao.getByRepoShaContext(item.repositoryId, item.headSha, context).catch(() => null);
      if (existing && existing.status === 'completed') return;
      if (existing) {
        id = existing.id;
      } else {
        try {
          const { UUIDUtil } = await import('@edge-git/shared/utils');
          const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
          await dao.create({
            id: UUIDUtil.getRandomUUID(),
            repositoryId: item.repositoryId,
            headSha: item.headSha,
            context,
            creatorEmail: item.actorEmail,
            now,
          });
          const created = await dao.getByRepoShaContext(item.repositoryId, item.headSha, context).catch(() => null);
          if (!created) return;
          id = created.id;
        } catch {
          return;
        }
      }
    }
    const done = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await dao
      .updateStatus(id, item.repositoryId, {
        status: 'completed',
        conclusion: step.conclusion,
        outputTitle: step.title,
        outputSummary: step.summary,
        now: done,
        completedAt: done,
      })
      .catch(() => undefined);
    await this.emitCheckCompleted(item, id, context, step.conclusion, step.title).catch(() => undefined);
  }

  private async executeCustom(
    dao: CheckRunDAO,
    repoStub: RepoStubShape,
    item: PendingItem,
    context: string,
    entry: CustomCheckDefinition,
  ): Promise<void> {
    const existing = await dao.getByRepoShaContext(item.repositoryId, item.headSha, context).catch(() => null);
    if (existing && existing.status === 'completed') return;
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    if (existing) {
      await dao
        .updateStatus(existing.id, item.repositoryId, { status: 'in_progress', conclusion: null, now, completedAt: null })
        .catch(() => undefined);
    }
    try {
      const maxScriptBytes = ConfigurationManager.checks.getCustomJsMaxScriptBytes(this.env);
      const script = await loadCheckScript(repoStub, item.headSha, entry.scriptPath, maxScriptBytes);
      if (script === null) {
        await this.completeCustom(dao, item, context, existing?.id ?? null, {
          conclusion: 'action_required',
          title: 'Check Script Unavailable',
          summary: `${entry.scriptPath} is missing, binary, or larger than ${maxScriptBytes} bytes.`,
        });
        return;
      }
      const files = await this.preloadTextFiles(repoStub, item.headSha);
      const cpuMs = ConfigurationManager.checks.getCustomJsMaxCpuMs(this.env);
      const maxFetches = ConfigurationManager.checks.getCustomJsMaxFetches(this.env);
      const fetchTimeoutMs = ConfigurationManager.webhooks.getTimeoutMs(this.env);
      const outcome = await runCustomCheckScript({
        script,
        files,
        env: entry.env,
        allowHosts: entry.allowHosts,
        limits: {
          cpuMs,
          memoryMb: ConfigurationManager.checks.getCustomJsMemoryMb(this.env),
          maxFetches,
          fetchTimeoutMs,
          maxResponseBytes: ConfigurationManager.webhooks.getMaxPayloadBytes(this.env),
          wallMs: cpuMs + maxFetches * fetchTimeoutMs + 5000,
          maxLogBytes: 4096,
        },
      });
      await this.completeCustom(dao, item, context, existing?.id ?? null, outcome);
    } catch (error) {
      await this.completeCustom(dao, item, context, existing?.id ?? null, {
        conclusion: 'action_required',
        title: 'Check Error',
        summary: error instanceof Error ? error.message.slice(0, 500) : 'Check execution failed.',
      });
    }
  }

  private async preloadTextFiles(repoStub: RepoStubShape, headSha: string): Promise<Record<string, string>> {
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

  private async executeBuiltIn(
    dao: CheckRunDAO,
    repoStub: RepoStubShape,
    item: PendingItem,
    runId: string,
    context: string,
  ): Promise<void> {
    const now = TimestampUtil.getCurrentUnixTimestampInSeconds();
    await dao
      .updateStatus(runId, item.repositoryId, { status: 'in_progress', conclusion: null, now, completedAt: null })
      .catch(() => undefined);
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

  private async runStep(repoStub: RepoStubShape, headSha: string, base: string, arg: string): Promise<StepOutcome> {
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
        const maxFiles = ConfigurationManager.repo.getMaxMergeDiffFiles(this.env);
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

  private async emitCheckCompleted(item: PendingItem, runId: string, context: string, conclusion: string, title: string): Promise<void> {
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
    await publishCheckLive(this.env, fullName, item, { runId, context, conclusion, title }).catch(() => undefined);
  }
}

export { CheckRunnerWorker };
export type { EnqueueChecksInput };
