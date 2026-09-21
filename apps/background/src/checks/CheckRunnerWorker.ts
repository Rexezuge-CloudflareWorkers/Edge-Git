import { DurableObject } from 'cloudflare:workers';
import type { CheckRunDAO } from '@edge-git/backend-data/dao';
import { Tokens, createRequestScope } from '@edge-git/backend-services/composition';
import { isBuiltInCheckContext } from '@edge-git/backend-services/checks';
import { ConfigurationManager } from '@edge-git/backend-runtime/config';
import { TimestampUtil, repoDoKeyForFullName } from '@edge-git/shared/utils';
import { createLogger } from '@edge-git/backend-runtime/logger';
import { loadCheckDefinition, loadCheckScript } from './CheckDefinition';
import type { CustomCheckDefinition, LoadedDefinition } from './CheckDefinition';
import { runCustomCheckScript } from './CustomJsSandbox';
import { publishCheckLive } from './CheckLivePublish';
import { executeBuiltInStep, preloadTextFiles } from './CheckStepExecutor';
import type { RepoStubShape } from './CheckStepExecutor';

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

const MAX_ATTEMPTS = 3;

// CI check executor: one DO per repo (`CHECK_RUNNER.getByName(repoDoKeyForFullName(fullName))`).
// Facade over CheckStepExecutor (built-in deterministic steps) + CustomJsSandbox
// (repo-defined custom-js): this DO owns only queue/alarm/routing + D1 status
// transitions so it stays under the god-file guard.
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
    // Canonical lowercase DO key (see doStubs.getRepoStub); the repositoryId
    // fallback is already opaque and never a display-case name.
    const repoStub = this.env.REPO.getByName(fullName ? repoDoKeyForFullName(fullName) : item.repositoryId) as unknown as RepoStubShape;
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
      await executeBuiltInStep(this.env, dao, repoStub, item, run.id, context, (runId, conclusion, title) =>
        this.emitCheckCompleted(item, runId, context, conclusion, title),
      );
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
      const files = await preloadTextFiles(repoStub, item.headSha);
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
