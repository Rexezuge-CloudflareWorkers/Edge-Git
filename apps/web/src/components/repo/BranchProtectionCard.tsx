import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import type { BranchProtectionRule } from '../../types';
import { createRule, deleteRule, listRules } from '../../services/ruleService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ConfirmDeleteModal } from '../modals/ConfirmDeleteModal';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export function BranchProtectionCard({
  owner,
  repo,
  showNotice,
}: {
  owner: string;
  repo: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const [rules, setRules] = useState<BranchProtectionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [pattern, setPattern] = useState('');
  const [requirePr, setRequirePr] = useState(true);
  const [requiredApprovals, setRequiredApprovals] = useState('1');
  const [blockForcePush, setBlockForcePush] = useState(true);
  const [blockDeletion, setBlockDeletion] = useState(true);
  const [requireStatusChecks, setRequireStatusChecks] = useState('');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<BranchProtectionRule | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const list = await listRules(owner, repo);
        if (!cancelled) setRules(list);
      } catch (error) {
        if (!cancelled)
          showNotice('error', toLocalizedErrorMessage(t, error, 'rules.failedToLoad', 'Failed To Load Protection Rules.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo, reloadKey, showNotice, t]);

  const refresh = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const approvals = Number(requiredApprovals);
    if (!Number.isSafeInteger(approvals) || approvals < 0 || approvals > 6) {
      showNotice('error', t('rules.invalidApprovals', 'Approvals Must Be An Integer 0-6.'));
      return;
    }
    setSaving(true);
    try {
      const checks = requireStatusChecks
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      await createRule(owner, repo, {
        pattern: pattern.trim(),
        requirePr,
        requiredApprovals: approvals,
        blockForcePush,
        blockDeletion,
        requireStatusChecks: checks,
      });
      setPattern('');
      setRequireStatusChecks('');
      showNotice('success', t('rules.ruleCreated', 'Protection Rule Created.'));
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'rules.failedToCreate', 'Failed To Create Protection Rule.'));
    } finally {
      setSaving(false);
    }
  };

  const confirmRemove = async () => {
    if (!removing) return;
    try {
      await deleteRule(owner, repo, removing.id);
      showNotice('success', t('rules.ruleDeleted', 'Protection Rule Deleted.'));
      refresh();
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'rules.failedToDelete', 'Failed To Delete Protection Rule.'));
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            {t('rules.branchProtection', 'Branch Protection')}
          </span>
        </CardTitle>
        <RefreshButton onRefresh={refresh} loading={loading} />
      </CardHeader>
      <form onSubmit={submit} className="space-y-3">
        <div className="flex gap-3 flex-wrap">
          <div className="flex-1 min-w-40">
            <Input
              placeholder={t('rules.patternPlaceholder', 'Pattern (e.g. main, release/*)')}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              required
            />
          </div>
          <div className="w-28">
            <Input
              aria-label={t('rules.requiredApprovals', 'Required Approvals')}
              placeholder="1"
              value={requiredApprovals}
              onChange={(e) => setRequiredApprovals(e.target.value)}
              inputMode="numeric"
            />
          </div>
          <div className="flex-1 min-w-40">
            <Input
              aria-label={t('rules.requireStatusChecks', 'Required Status Checks')}
              placeholder={t('rules.checksPlaceholder', 'Required Checks (e.g. secret-scan, diff-limit)')}
              value={requireStatusChecks}
              onChange={(e) => setRequireStatusChecks(e.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" size="sm" loading={saving}>
            {t('rules.addRule', 'Add Rule')}
          </Button>
        </div>
        <div className="flex gap-4 flex-wrap">
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={requirePr}
              onChange={(e) => setRequirePr(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            {t('rules.requirePr', 'Require Pull Request')}
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={blockForcePush}
              onChange={(e) => setBlockForcePush(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            {t('rules.blockForcePush', 'Block Force Push')}
          </label>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)] cursor-pointer">
            <input
              type="checkbox"
              checked={blockDeletion}
              onChange={(e) => setBlockDeletion(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            {t('rules.blockDeletion', 'Block Deletion')}
          </label>
        </div>
      </form>
      <ul className="mt-4 divide-y divide-[var(--color-border)]">
        {rules.map((rule) => (
          <li key={rule.id} className="py-3 flex items-center justify-between gap-3 first:pt-0 last:pb-0">
            <div className="min-w-0">
              <p className="font-medium font-mono text-[var(--color-text-primary)] truncate">{rule.pattern}</p>
              <p className="text-xs text-[var(--color-text-muted)]">
                {rule.requirePr ? t('rules.prRequired', 'PR Required') : t('rules.directPushOk', 'Direct Push Allowed')}
                {rule.requiredApprovals > 0 && ` · ${t('rules.approvals', '{{count}} Approvals', { count: rule.requiredApprovals })}`}
                {rule.blockForcePush && ` · ${t('rules.noForcePush', 'No Force Push')}`}
                {rule.blockDeletion && ` · ${t('rules.noDelete', 'No Delete')}`}
                {rule.requireStatusChecks.length > 0 &&
                  ` · ${t('rules.checks', 'Checks: {{contexts}}', { contexts: rule.requireStatusChecks.join(', ') })}`}
              </p>
            </div>
            <Button variant="danger" size="sm" onClick={() => setRemoving(rule)}>
              {t('common.delete', 'Delete')}
            </Button>
          </li>
        ))}
      </ul>
      {rules.length === 0 && !loading && (
        <p className="text-sm text-[var(--color-text-muted)] mt-4">{t('rules.noRules', 'No Protection Rules Yet.')}</p>
      )}
      <p className="mt-3 text-xs text-[var(--color-text-muted)]">
        {t('rules.adminNote', 'Rules Apply To Everyone Including Admins. Delete A Rule To Push Directly.')}
      </p>

      {removing && (
        <ConfirmDeleteModal
          title={t('rules.deleteRule', 'Delete Protection Rule')}
          displayName={removing.pattern}
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </Card>
  );
}
