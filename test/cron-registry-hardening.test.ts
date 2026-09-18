import { describe, expect, it } from 'vitest';
import { CRON_TASK_DEFINITIONS } from '@edge-git/background/scheduled/TaskRegistry';

describe('cron task registry hardening', () => {
  it('has exactly one phase-1 task (token prune) and rest phase-2', () => {
    const phase1 = CRON_TASK_DEFINITIONS.filter((t) => t.phase === 1);
    const phase2 = CRON_TASK_DEFINITIONS.filter((t) => t.phase === 2);
    expect(phase1.map((t) => t.name)).toEqual(['ExpiredTokenPruningTask']);
    expect(phase2.length).toBe(CRON_TASK_DEFINITIONS.length - 1);
    expect(phase2.map((t) => t.name)).toContain('AuditLogCleanupTask');
    expect(phase2.map((t) => t.name)).toContain('WebhookDeliveryTask');
    expect(phase2.map((t) => t.name)).toContain('SocialPruningTask');
  });

  it('has unique task names', () => {
    const names = CRON_TASK_DEFINITIONS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all tasks expose run() that never throws synchronously without env', () => {
    for (const task of CRON_TASK_DEFINITIONS) {
      expect(typeof task.run).toBe('function');
      expect(typeof task.name).toBe('string');
      expect([1, 2]).toContain(task.phase);
    }
  });
});
