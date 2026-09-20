import type { CheckRunnerWorker, RealtimeWorker, RepoWorker } from '@edge-git/background';
import { repoDoKeyForFullName } from '@edge-git/shared/utils';

function getRepoStub(env: Env, fullName: string): DurableObjectStub & RepoWorker {
  // BREAKING: route by canonical lowercase key so `Foo/Bar` and `foo/bar`
  // share one isolate (D1 matches via `owner_ci/name_ci`). Display case is
  // still persisted via `setFullName(fullName)`.
  const stub = env.REPO.getByName(repoDoKeyForFullName(fullName)) as unknown as DurableObjectStub & RepoWorker;
  // Name persistence is first-writer-wins in `setFullName`; callers that need
  // it durably must `await ensureRepo`. Fire-and-forget here only warms the
  // isolate — failures are ignored because read paths call `prepare()` which
  // loads the stored name.
  void (stub.setFullName(fullName) as Promise<unknown>).catch(() => undefined);
  return stub;
}

async function ensureRepo(env: Env, fullName: string): Promise<DurableObjectStub & RepoWorker> {
  const stub = env.REPO.getByName(repoDoKeyForFullName(fullName)) as unknown as DurableObjectStub & RepoWorker;
  await stub.setFullName(fullName);
  await stub.ensureRepoInitialized();
  return stub;
}

function getCheckRunnerStub(env: Env, fullName: string): DurableObjectStub & CheckRunnerWorker {
  const ns = (env as unknown as { CHECK_RUNNER?: DurableObjectNamespace }).CHECK_RUNNER;
  if (!ns) throw new Error('CHECK_RUNNER binding is not configured');
  const stub = ns.getByName(repoDoKeyForFullName(fullName)) as unknown as DurableObjectStub & CheckRunnerWorker;
  return stub;
}

function getRealtimeStub(env: Env, shard: string): DurableObjectStub & RealtimeWorker {
  const ns = (env as unknown as { REALTIME?: DurableObjectNamespace }).REALTIME;
  if (!ns) throw new Error('REALTIME binding is not configured');
  const stub = ns.getByName(shard) as unknown as DurableObjectStub & RealtimeWorker;
  return stub;
}

export { getRepoStub, ensureRepo, getCheckRunnerStub, getRealtimeStub };
