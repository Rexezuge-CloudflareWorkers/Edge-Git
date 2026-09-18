import type { RealtimeWorker } from '@edge-git/background';

export function getRealtimeStub(env: Env, shard: string): DurableObjectStub & RealtimeWorker {
  const ns = (env as unknown as { REALTIME?: DurableObjectNamespace }).REALTIME;
  if (!ns) throw new Error('REALTIME binding is not configured');
  const stub = ns.getByName(shard) as unknown as DurableObjectStub & RealtimeWorker;
  return stub;
}
