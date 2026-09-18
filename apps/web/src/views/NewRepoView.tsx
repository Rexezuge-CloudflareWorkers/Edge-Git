import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { createRepo } from '../services/repoService';
import { listMyOrgs } from '../services/profileService';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { Input, Label, Select, Textarea } from '../components/ui/Input';
import { ContextBar } from '../components/layout/ContextBar';
import { AppPage } from '../components/layout/AppPage';

export function NewRepoView({
  defaultOwner,
  showNotice,
}: {
  defaultOwner: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [owner, setOwner] = useState(defaultOwner);
  const [owners, setOwners] = useState<string[]>([defaultOwner]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const orgs = await listMyOrgs();
        if (cancelled) return;
        const next = [defaultOwner, ...orgs.map((o) => o.username).filter((u) => u.toLowerCase() !== defaultOwner.toLowerCase())];
        setOwners(next);
        setOwner((prev) => prev || defaultOwner);
      } catch {
        if (!cancelled) setOwners([defaultOwner]);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [defaultOwner]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const repo = await createRepo({
        owner: owner.trim() || undefined,
        name: name.trim(),
        description: description.trim() || null,
        isPrivate,
      });
      showNotice('success', `Repository ${repo.fullName} Created.`);
      void navigate(`/${repo.owner}/${repo.name}`);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : 'Failed To Create Repository.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <ContextBar
        crumb={<span className="text-xl font-semibold text-[var(--color-text-primary)] truncate">New Repository</span>}
      />
      <AppPage variant="narrow">
      <Card>
        <CardHeader>
          <CardTitle>New Repository</CardTitle>
        </CardHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label className="mb-1.5">Owner</Label>
            <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-full">
              {owners.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
            <p className="text-xs text-[var(--color-text-muted)] mt-1">
              {t('repos.ownerHint', 'Personal Or Organization You Belong To. Manage Organizations From The Dashboard New Menu.')}
            </p>
          </div>
          <div>
            <Label className="mb-1.5">Repository Name</Label>
            <Input placeholder="my-project" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <Label className="mb-1.5">Description</Label>
            <Textarea
              placeholder="What does this repository contain?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
            Private repository
          </label>
          <Button type="submit" variant="primary" loading={saving}>
            Create Repository
          </Button>
        </form>
      </Card>
      </AppPage>
    </div>
  );
}
