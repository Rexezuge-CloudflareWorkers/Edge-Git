import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StickyNote } from 'lucide-react';
import type { Snippet, SnippetFile } from '../types';
import { createSnippet, deleteSnippet, listMySnippets, listPublicSnippets, loadSnippet, updateSnippet } from '../services/snippetService';
import { Button } from '../components/ui/Button';
import { Card, CardHeader, CardTitle } from '../components/ui/Card';
import { Input, Textarea } from '../components/ui/Input';
import { RefreshButton } from '../components/shared/RefreshButton';

export function SnippetsView({
  showNotice,
  authorized,
}: {
  showNotice: (type: 'success' | 'error', text: string) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'public' | 'mine'>('public');
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [files, setFiles] = useState<SnippetFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [filename, setFilename] = useState('');
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'secret'>('public');
  const [saving, setSaving] = useState(false);

  const signedIn = authorized === true;
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const list = signedIn && tab === 'mine' ? await listMySnippets() : await listPublicSnippets();
        if (!cancelled) setSnippets(list);
      } catch (error) {
        if (!cancelled) showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadSnippets', 'Failed To Load Snippets.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [tab, signedIn, showNotice, t, reloadKey]);

  const reload = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  const openSnippet = async (id: string) => {
    setSelected(id);
    try {
      const detail = await loadSnippet(id);
      setFiles(detail.files);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadSnippets', 'Failed To Load Snippets.'));
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!body || !filename.trim()) return;
    setSaving(true);
    try {
      const created = await createSnippet({ title: title.trim() || filename.trim(), visibility, files: [{ filename: filename.trim(), body }] });
      setTitle('');
      setFilename('');
      setBody('');
      showNotice('success', t('snippets.snippetCreated', 'Snippet Created.'));
      reload();
      setSelected(created.snippet.id);
      setFiles(created.files);
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('errors.failedToCreateSnippet', 'Failed To Create Snippet.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-6 space-y-4">
      <div className="flex gap-2">
        <Button size="sm" variant={tab === 'public' ? 'primary' : undefined} onClick={() => setTab('public')}>{t('snippets.public', 'Public')}</Button>
        {signedIn && <Button size="sm" variant={tab === 'mine' ? 'primary' : undefined} onClick={() => setTab('mine')}>{t('snippets.mine', 'Mine')}</Button>}
      </div>

      {signedIn && (
        <Card>
          <CardHeader>
            <CardTitle>{t('snippets.newSnippet', 'New Snippet')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-3">
            <Input placeholder={t('snippets.titlePlaceholder', 'Title (Optional)')} value={title} onChange={(e) => setTitle(e.target.value)} />
            <div className="flex gap-2">
              <Input placeholder={t('snippets.filenamePlaceholder', 'hello.txt')} value={filename} onChange={(e) => setFilename(e.target.value)} required />
              <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'public' | 'secret')} className="rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1.5 text-sm">
                <option value="public">{t('snippets.public', 'Public')}</option>
                <option value="secret">{t('snippets.secret', 'Secret')}</option>
              </select>
            </div>
            <Textarea placeholder={t('snippets.bodyPlaceholder', 'Code…')} value={body} onChange={(e) => setBody(e.target.value)} rows={6} required />
            <Button type="submit" variant="primary" size="sm" loading={saving}>{t('snippets.createSnippet', 'Create Snippet')}</Button>
          </form>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{tab === 'mine' ? t('snippets.mine', 'Mine') : t('snippets.public', 'Public')}</CardTitle>
          <RefreshButton onRefresh={reload} loading={loading} />
        </CardHeader>
        {!loading && snippets.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
            <StickyNote className="h-6 w-6 mx-auto mb-3" />
            {t('snippets.noSnippets', 'No Snippets Yet.')}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {snippets.map((s) => (
              <li key={s.id} className="py-2 flex items-center gap-2 flex-wrap">
                <button type="button" onClick={() => void openSnippet(s.id)} className="text-left text-[var(--color-accent)] hover:underline">
                  {s.title || s.id.slice(0, 8)}
                </button>
                <span className="text-xs text-[var(--color-text-muted)]">{s.visibility} · {s.ownerEmail}</span>
                {signedIn && tab === 'mine' && (
                  <>
                    <Button size="sm" onClick={() => updateSnippet(s.id, { visibility: s.visibility === 'public' ? 'secret' : 'public' }).then(() => reload())}>
                      {s.visibility === 'public' ? t('snippets.makeSecret', 'Make Secret') : t('snippets.makePublic', 'Make Public')}
                    </Button>
                    <Button size="sm" onClick={() => deleteSnippet(s.id).then(() => { if (selected === s.id) { setSelected(null); setFiles([]); } reload(); })}>
                      {t('common.delete', 'Delete')}
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {selected && files.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-mono">{selected.slice(0, 8)}</CardTitle>
          </CardHeader>
          {files.map((f) => (
            <div key={f.id} className="mb-3">
              <p className="text-sm font-medium">{f.filename}</p>
              <pre className="mt-1 overflow-auto rounded bg-[var(--color-surface-base)] p-3 text-xs">{f.body}</pre>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
