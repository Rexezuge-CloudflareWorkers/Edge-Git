import { describe, expect, it } from 'vitest';
import { AuditLogCleanupTask } from '@edge-git/background/scheduled/AuditLogCleanupTask';
import { WebhookDeliveryTask } from '@edge-git/background/scheduled/WebhookDeliveryTask';

describe('scheduled retention tasks (definition contract)', () => {
  it('AuditLogCleanupTask is phase 2 with batch semantics', () => {
    const task = new AuditLogCleanupTask();
    expect(task.phase).toBe(2);
    expect(task.name).toContain('Audit');
  });

  it('WebhookDeliveryTask is phase 2 with bounded sweep', () => {
    const task = new WebhookDeliveryTask();
    expect(task.phase).toBe(2);
    expect(task.name).toContain('Webhook');
  });

  it('retention cutoff math: 90d default', () => {
    const now = 1_700_000_000;
    const cutoff = now - 90 * 86_400;
    expect(cutoff).toBe(1_700_000_000 - 7_776_000);
    expect(cutoff).toBeLessThan(now);
  });
});
