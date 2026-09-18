import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookOpen } from 'lucide-react';
import type { WikiPage, WikiRevision } from '../../types';
import { createWikiPage, deleteWikiPage, listWikiPages, loadWikiPage, loadWikiRevisions, updateWikiPage } from '../../services/wikiService';
import { isValidWikiSlug, normalizeWikiSlug, titleToSlug } from '../../lib/wikiSlug';
import { readParam, writeParams } from '../../lib/urlParams';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Textarea } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { Markdown } from '../shared/Markdown';

export function WikiTab({
  owner,
  repo,
  canWrite,
  showNotice,
  authorized,
}: {
  owner: string;
  repo: string;
  canWrite: boolean;
  showNotice: (type: 'success' | 'error', text: string) => void;
  authorized?: boolean | null;
}) {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [pages, setPages] = useState<WikiPage[]>([]);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [revisions, setRevisions] = useState<WikiRevision[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState('');
  const [slugInput, setSlugInput] = useState('');
  const [body, setBody] = useState('');
  const [saving, setSaving] = useState(false);
  // Search + open page are URL state (`?q=&page=`) with the URL as the single
  // source of truth: typing and page opens write the query directly, so
  // pasted links, Back, and keystrokes can never disagree.
  const [reloadKey, setReloadKey] = useState(0);
  const query = readParam(params, 'q');
  const slug = readParam(params, 'page') || null;
  const setQuery = (next: string) => {
    writeParams(setParams, params, { q: next.trim() });
  };
  const setSlug = (next: string | null) => {
    writeParams(setParams, params, { page: next ?? '' });
  };

  useEffect(() => {
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const run = async () => {
      try {
        setPages(await listWikiPages(owner, repo, query.trim() || undefined, authOpt));
      } catch (error) {
        showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadWiki', 'Failed To Load Wiki.'));
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [owner, repo, showNotice, t, authorized, query, reloadKey]);

  const reload = () => {
    setLoading(true);
    setReloadKey((k) => k + 1);
  };

  // Page navigation writes the URL only; the loader effect below performs
  // the single async load for clicks, submits, and pasted links alike.
  const selectPage = (nextSlug: string | null) => {
    setPage(null);
    setEditing(false);
    setShowHistory(false);
    setSlug(nextSlug);
  };

  // Sole page loader: `slug` derives from the URL, so clicks, submits, and
  // pasted links all converge here with no state syncing. Written as an
  // effect-local `run()` like every other data loader in the codebase; all
  // updates happen after the await.
  useEffect(() => {
    if (!slug) return;
    const authOpt = authorized === true ? { isAuthed: true as const } : { isAuthed: false as const };
    const target = slug;
    let cancelled = false;
    const run = async () => {
      try {
        const { page: loaded } = await loadWikiPage(owner, repo, target, authOpt);
        if (cancelled) return;
        setPage(loaded);
        setTitle(loaded.title);
        setBody(loaded.body);
        setSlugInput(loaded.slug);
      } catch (error) {
        if (cancelled) return;
        showNotice('error', error instanceof Error ? error.message : t('errors.failedToLoadWiki', 'Failed To Load Wiki.'));
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  const startNew = () => {
    selectPage(null);
    setEditing(true);
    setTitle('');
    setBody('');
    setSlugInput('');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const finalSlug = slugInput.trim() ? normalizeWikiSlug(slugInput) : titleToSlug(title);
    if (!isValidWikiSlug(finalSlug)) {
      showNotice('error', t('wiki.invalidSlug', 'Slug Must Be Lowercase Letters, Numbers, And Hyphens.'));
      return;
    }
    setSaving(true);
    try {
      if (page && slug) {
        const { page: updated } = await updateWikiPage(owner, repo, slug, { title: title.trim(), body, expectedRevision: page.revision });
        setPage(updated);
        showNotice('success', t('wiki.pageUpdated', 'Wiki Page Updated.'));
      } else {
        const { page: created } = await createWikiPage(owner, repo, { slug: finalSlug, title: title.trim(), body });
        setPage(created);
        setSlug(created.slug);
        showNotice('success', t('wiki.pageCreated', 'Wiki Page Created.'));
      }      setEditing(false);
      reload();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      showNotice('error', message.includes('409') || message.includes('revision conflict') ? t('wiki.conflict', 'Someone Else Updated This Page. Reload And Retry.') : message || t('errors.failedToSaveWiki', 'Failed To Save Wiki Page.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('wiki.wiki', 'Wiki')}</CardTitle>
          <div className="flex gap-2">
            <Input placeholder={t('wiki.searchPlaceholder', 'Search Pages…')} value={query} onChange={(e) => setQuery(e.target.value)} />
            <RefreshButton onRefresh={reload} loading={loading} />
            {canWrite && <Button size="sm" variant="primary" onClick={startNew}>{t('wiki.newPage', 'New Page')}</Button>}
          </div>
        </CardHeader>
        {!loading && pages.length === 0 ? (
          <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">
            <BookOpen className="h-6 w-6 mx-auto mb-3" />
            {t('wiki.noPages', 'No Wiki Pages Yet.')}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {pages.map((p) => (
              <li key={p.id} className="py-2 flex items-center gap-2">
                <button type="button" onClick={() => selectPage(p.slug)} className={`text-left hover:underline ${slug === p.slug ? 'font-medium text-[var(--color-accent)]' : 'text-[var(--color-accent)]'}`}>
                  {p.title}
                </button>
                <span className="text-xs text-[var(--color-text-muted)]">/{p.slug} · r{p.revision}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {page && !editing && (
        <Card>
          <CardHeader>
            <CardTitle>{page.title}</CardTitle>
            <div className="flex gap-2">
              {canWrite && <Button size="sm" onClick={() => setEditing(true)}>{t('wiki.edit', 'Edit')}</Button>}
              <Button size="sm" onClick={() => { setShowHistory((v) => !v); if (!showHistory) void loadWikiRevisions(owner, repo, page.slug).then(setRevisions); }}>
                {t('wiki.history', 'History')}
              </Button>
              {canWrite && (
                <Button size="sm" onClick={() => deleteWikiPage(owner, repo, page.slug).then(() => { setPage(null); setSlug(null); reload(); })}>
                  {t('common.delete', 'Delete')}
                </Button>
              )}
            </div>
          </CardHeader>
          <Markdown content={page.body || `_${t('wiki.emptyPage', 'Empty Page.')}_`} />
          {showHistory && (
            <ul className="mt-4 space-y-1 text-xs text-[var(--color-text-muted)]">
              {revisions.map((r) => (
                <li key={r.id}>r{r.revision} · {r.authorEmail}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {editing && canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>{page ? t('wiki.editPage', 'Edit Page') : t('wiki.newPage', 'New Page')}</CardTitle>
          </CardHeader>
          <form onSubmit={submit} className="space-y-3">
            <Input placeholder={t('wiki.titlePlaceholder', 'Page Title')} value={title} onChange={(e) => setTitle(e.target.value)} required />
            <Input placeholder={t('wiki.slugPlaceholder', 'page-slug')} value={slugInput} onChange={(e) => setSlugInput(e.target.value)} disabled={!!page} />
            <Textarea placeholder={t('wiki.bodyPlaceholder', 'Markdown Content…')} value={body} onChange={(e) => setBody(e.target.value)} rows={10} />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" size="sm" loading={saving}>{t('common.saveChanges', 'Save Changes')}</Button>
              <Button type="button" size="sm" onClick={() => setEditing(false)}>{t('common.cancel', 'Cancel')}</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
