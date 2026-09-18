import type { CheckRunnerWorker, RealtimeWorker, RepoWorker } from '@edge-git/background';

function getRepoStub(env: Env, fullName: string): DurableObjectStub & RepoWorker {
  const stub = env.REPO.getByName(fullName) as unknown as DurableObjectStub & RepoWorker;
  // Fire-and-forget fullName persistence; ensure is also called explicitly on create.
  void (stub.setFullName(fullName) as Promise<unknown>).catch(() => undefined);
  return stub;
}

async function ensureRepo(env: Env, fullName: string): Promise<DurableObjectStub & RepoWorker> {
  const stub = env.REPO.getByName(fullName) as unknown as DurableObjectStub & RepoWorker;
  await stub.setFullName(fullName);
  await stub.ensureRepoInitialized();
  return stub;
}

function getCheckRunnerStub(env: Env, fullName: string): DurableObjectStub & CheckRunnerWorker {
  const ns = (env as unknown as { CHECK_RUNNER?: DurableObjectNamespace }).CHECK_RUNNER;
  if (!ns) throw new Error('CHECK_RUNNER binding is not configured');
  const stub = ns.getByName(fullName) as unknown as DurableObjectStub & CheckRunnerWorker;
  return stub;
}

function getRealtimeStub(env: Env, shard: string): DurableObjectStub & RealtimeWorker {
  const ns = (env as unknown as { REALTIME?: DurableObjectNamespace }).REALTIME;
  if (!ns) throw new Error('REALTIME binding is not configured');
  const stub = ns.getByName(shard) as unknown as DurableObjectStub & RealtimeWorker;
  return stub;
}

export { getRepoStub, ensureRepo, getCheckRunnerStub, getRealtimeStub };
