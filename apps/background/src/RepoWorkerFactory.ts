import { createDofsFs, GitService, IsoGitFs } from '@edge-git/git-service';
import type { DofsFs } from '@edge-git/git-service';
import { AppConfiguration } from '@edge-git/backend-runtime/config';
import { FetchHandler } from './FetchHandler';
import { PushHandler } from './PushHandler';
import { ReadModelService } from './ReadModelService';
import { ReleaseAssetStore } from './ReleaseAssetStore';
import { RepoLifecycle } from './RepoLifecycle';
import { RepoReadRpc } from './RepoReadRpc';

interface RepoWorkerDeps {
  dofs: DofsFs;
  isoGitFs: ReturnType<IsoGitFs['getPromiseFsClient']>;
  git: GitService;
  config: AppConfiguration;
  fetchHandler: FetchHandler;
  pushHandler: PushHandler;
  readModel: ReadModelService;
  releaseAssets: ReleaseAssetStore;
  lifecycle: RepoLifecycle;
  reads: RepoReadRpc;
}

/**
 * Composition root for `RepoWorker` (Factory pattern). Extracts the 30-line
 * `new X(...)` wiring out of the Durable Object constructor so the DO keeps
 * routing/lifecycle only and the graph is unit-testable without workerd.
 */
function createRepoWorkerDeps(
  ctx: DurableObjectState,
  env: Env,
  hooks: { getFullName: () => string | undefined; loadFullName: () => Promise<void>; prepare: () => Promise<void> },
): RepoWorkerDeps {
  const dofs = createDofsFs(ctx, env);
  const isoGitFs = new IsoGitFs(dofs).getPromiseFsClient();
  const git = new GitService(isoGitFs, '/repo');
  const config = AppConfiguration.fromEnv(env);
  const fetchHandler = new FetchHandler({ git, env, getFullName: hooks.getFullName });
  const pushHandler = new PushHandler({ isoGitFs, git, getFullName: hooks.getFullName });
  const readModel = new ReadModelService(git);
  const releaseAssets = new ReleaseAssetStore(isoGitFs, env);
  const lifecycle = new RepoLifecycle(ctx, env, dofs, isoGitFs, git, config, hooks.getFullName, hooks.loadFullName);
  const reads = new RepoReadRpc({
    git,
    readModel,
    prepare: hooks.prepare,
    config,
    isoGitFs,
    releaseAssets,
    getLimits: () => lifecycle.getLimits(),
  });
  return { dofs, isoGitFs, git, config, fetchHandler, pushHandler, readModel, releaseAssets, lifecycle, reads };
}

export { createRepoWorkerDeps };
export type { RepoWorkerDeps };
