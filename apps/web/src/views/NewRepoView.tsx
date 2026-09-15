import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createRepo } from '../services/repoService';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { Input, Label, Textarea } from '../components/ui/Input';

export function NewRepoView({
  defaultOwner,
  showNotice,
}: {
  defaultOwner: string;
  showNotice: (type: 'success' | 'error', text: string) => void;
}) {
  const navigate = useNavigate();
  const [owner, setOwner] = useState(defaultOwner);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [saving, setSaving] = useState(false);

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
    <div className="max-w-2xl mx-auto px-6 py-8">
      <Card>
        <CardHeader>
          <CardTitle>New Repository</CardTitle>
        </CardHeader>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <Label className="mb-1.5">Owner</Label>
            <Input placeholder="owner (default: you)" value={owner} onChange={(e) => setOwner(e.target.value)} />
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
    </div>
  );
}
