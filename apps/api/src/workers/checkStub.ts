import type { CheckRunnerWorker } from '@edge-git/background';

export function getCheckRunnerStub(env: Env, fullName: string): DurableObjectStub & CheckRunnerWorker {
  const ns = (env as unknown as { CHECK_RUNNER?: DurableObjectNamespace }).CHECK_RUNNER;
  if (!ns) throw new Error('CHECK_RUNNER binding is not configured');
  const stub = ns.getByName(fullName) as unknown as DurableObjectStub & CheckRunnerWorker;
  return stub;
}
