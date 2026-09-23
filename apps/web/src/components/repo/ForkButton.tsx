import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { GitFork } from 'lucide-react';
import { forkRepo } from '../../services/forkService';
import { listMyOrgs } from '../../services/profileService';
import { Button } from '../ui/Button';
import { Input, Label, Select } from '../ui/Input';
import { ModalBody, ModalHeader, ModalShell } from '../modals/ModalShell';
import { toLocalizedErrorMessage } from '../../lib/backendErrors';

export function ForkButton({
  owner,
  repo,
  defaultOwner,
  forksCount,
  authorized,
  showNotice,
}: {
  owner: string;
  repo: string;
  defaultOwner: string;
  forksCount?: number;
  authorized?: boolean | null;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [forkOwner, setForkOwner] = useState(defaultOwner);
  const [owners, setOwners] = useState<string[]>([defaultOwner]);
  const [forkName, setForkName] = useState(repo);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (authorized !== true) return;
    let cancelled = false;
    const run = async () => {
      try {
        const orgs = await listMyOrgs();
        if (cancelled) return;
        const next = [defaultOwner, ...orgs.map((o) => o.username).filter((u) => u.toLowerCase() !== defaultOwner.toLowerCase())];
        setOwners(next);
        setForkOwner((prev) => prev || defaultOwner);
      } catch {
        if (!cancelled) setOwners([defaultOwner]);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [defaultOwner, authorized]);

  const openModal = () => {
    if (authorized !== true) {
      showNotice('error', t('social.signInToStar', 'Sign In To Star Or Watch Repositories.'));
      return;
    }
    setForkOwner((prev) => (owners.includes(prev) ? prev : defaultOwner));
    setForkName(repo);
    setOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const created = await forkRepo(owner, repo, { owner: forkOwner.trim() || undefined, name: forkName.trim() || undefined });
      setOpen(false);
      showNotice('success', t('forks.forkCreated', 'Fork {{fullName}} Created.', { fullName: created.fullName }));
      await navigate(`/${created.owner}/${created.name}`);
    } catch (error) {
      showNotice('error', toLocalizedErrorMessage(t, error, 'errors.failedToFork', 'Failed To Fork Repository.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={openModal}>
        <GitFork className="h-3.5 w-3.5" />
        {t('forks.fork', 'Fork')}
        <span className="text-xs text-[var(--color-text-muted)]">{forksCount ?? 0}</span>
      </Button>
      {open && (
        <ModalShell onClose={() => setOpen(false)} widthClass="w-full max-w-md mx-4" ariaLabel={t('forks.fork', 'Fork')}>
          <ModalHeader
            title={t('forks.forkRepository', 'Fork {{fullName}}', { fullName: `${owner}/${repo}` })}
            onClose={() => setOpen(false)}
          />
          <ModalBody>
            <form onSubmit={submit} className="space-y-3">
              <div>
                <Label className="mb-1.5">{t('repos.owner', 'Owner')}</Label>
                <Select value={forkOwner} onChange={(e) => setForkOwner(e.target.value)} className="w-full">
                  {owners.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </Select>
                <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                  {t('forks.ownerHint', 'Your Username Or An Organization You Belong To.')}
                </p>
              </div>
              <div>
                <Label className="mb-1.5">{t('repos.repositoryName', 'Repository Name')}</Label>
                <Input value={forkName} onChange={(e) => setForkName(e.target.value)} placeholder={repo} required />
              </div>
              <Button type="submit" variant="primary" size="sm" loading={saving}>
                {t('forks.createFork', 'Create Fork')}
              </Button>
            </form>
          </ModalBody>
        </ModalShell>
      )}
    </>
  );
}
