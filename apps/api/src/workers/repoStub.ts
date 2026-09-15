import type { RepoWorker } from '@edge-git/background';

export function getRepoStub(env: Env, fullName: string): DurableObjectStub & RepoWorker {
  const stub = env.REPO.getByName(fullName) as unknown as DurableObjectStub & RepoWorker;
  // Fire-and-forget fullName persistence; ensure is also called explicitly on create.
  void (stub.setFullName(fullName) as Promise<unknown>).catch(() => undefined);
  return stub;
}

export async function ensureRepo(env: Env, fullName: string): Promise<DurableObjectStub & RepoWorker> {
  const stub = env.REPO.getByName(fullName) as unknown as DurableObjectStub & RepoWorker;
  await stub.setFullName(fullName);
  await stub.ensureRepoInitialized();
  return stub;
}
