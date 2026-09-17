import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, RefreshCw } from 'lucide-react';
import type { RepoImportJob, RepoMirror } from '../../types';
import { cancelImport, deleteMirror, exportRepo, getImport, getMirror, putMirror, setMirrorEnabled, startImport, syncMirror } from '../../services/transferService';
import { Button } from '../ui/Button';
import { Card, CardHeader, CardTitle } from '../ui/Card';
import { Input, Label, Select } from '../ui/Input';
import { RefreshButton } from '../shared/RefreshButton';
import { ReadOnlyField } from '../shared/ReadOnlyField';

const MIRROR_INTERVALS = [60, 360, 720, 1440, 10_080];

function intervalLabel(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${minutes / 60}h`;
  return `${minutes / 1440}d`;
}

function downloadBytes(filename: string, bytes: Uint8Array, mime: string): void {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.codePointAt(i) ?? 0;
  return bytes;
}

export function TransferCard({ owner, repo, showNotice }: { owner: string; repo: string; showNotice: (type: 'success' | 'error', text: string) => void }) {
  const { t } = useTranslation();
  const [sourceUrl, setSourceUrl] = useState('');
  const [job, setJob] = useState<RepoImportJob | null>(null);
  const [starting, setStarting] = useState(false);
  const [mirror, setMirror] = useState<RepoMirror | null>(null);
  const [mirrorUrl, setMirrorUrl] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(1440);
  const [savingMirror, setSavingMirror] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    setLoading(true);
    try {
      const [importJob, currentMirror] = await Promise.all([
        getImport(owner, repo).catch(() => null),
        getMirror(owner, repo).catch(() => null),
      ]);
      setJob(importJob);
      setMirror(currentMirror);
      if (currentMirror) {
        setMirrorUrl(currentMirror.sourceUrl);
        setIntervalMinutes(currentMirror.intervalMinutes);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      try {
        const [importJob, currentMirror] = await Promise.all([
          getImport(owner, repo).catch(() => null),
          getMirror(owner, repo).catch(() => null),
        ]);
        if (cancelled) return;
        setJob(importJob);
        setMirror(currentMirror);
        if (currentMirror) {
          setMirrorUrl(currentMirror.sourceUrl);
          setIntervalMinutes(currentMirror.intervalMinutes);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [owner, repo]);

  const submitImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!sourceUrl.trim()) return;
    setStarting(true);
    try {
      const created = await startImport(owner, repo, sourceUrl.trim());
      setJob(created);
      setSourceUrl('');
      showNotice('success', t('transfer.importStarted', 'Import Started. Status Updates Automatically.'));
      void refresh();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('transfer.importFailed', 'Failed To Start Import.'));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!job) return;
    try {
      setJob(await cancelImport(owner, repo, job.id));
      showNotice('success', t('transfer.importCancelled', 'Import Cancelled.'));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('transfer.cancelFailed', 'Failed To Cancel Import.'));
    }
  };

  const saveMirror = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mirrorUrl.trim()) return;
    setSavingMirror(true);
    try {
      setMirror(await putMirror(owner, repo, mirrorUrl.trim(), intervalMinutes));
      showNotice('success', t('transfer.mirrorSaved', 'Mirror Configured.'));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('transfer.mirrorFailed', 'Failed To Configure Mirror.'));
    } finally {
      setSavingMirror(false);
    }
  };

  const syncNow = async () => {
    try {
      setMirror(await syncMirror(owner, repo));
      showNotice('success', t('transfer.mirrorSyncStarted', 'Mirror Sync Started.'));
      void refresh();
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('transfer.syncFailed', 'Failed To Sync Mirror.'));
    }
  };

  const toggleMirror = async () => {
    if (!mirror) return;
    try {
      setMirror(await setMirrorEnabled(owner, repo, !mirror.enabled));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('transfer.mirrorFailed', 'Failed To Configure Mirror.'));
    }
  };

  const removeMirror = async () => {
    try {
      await deleteMirror(owner, repo);
      setMirror(null);
      setMirrorUrl('');
      showNotice('success', t('transfer.mirrorRemoved', 'Mirror Removed.'));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('transfer.mirrorFailed', 'Failed To Configure Mirror.'));
    }
  };

  const doExport = async () => {
    setExporting(true);
    try {
      const result = await exportRepo(owner, repo);
      downloadBytes(`${repo}.pack`, base64ToBytes(result.packBase64), 'application/octet-stream');
      downloadBytes(`${repo}-refs.json`, new TextEncoder().encode(JSON.stringify(result.refs, null, 2)), 'application/json');
      showNotice('success', t('transfer.exportDone', 'Export Downloaded (Pack + Refs).'));
    } catch (error) {
      showNotice('error', error instanceof Error ? error.message : t('transfer.exportFailed', 'Failed To Export Repository.'));
    } finally {
      setExporting(false);
    }
  };

  const jobActive = job?.status === 'pending' || job?.status === 'running';

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('transfer.title', 'Import / Mirror / Export')}</CardTitle>
        <RefreshButton onRefresh={() => void refresh()} loading={loading} />
      </CardHeader>
      <div className="space-y-5">
        <form onSubmit={submitImport} className="space-y-2">
          <Label>{t('transfer.importFrom', 'Import From Public Git URL')}</Label>
          <div className="flex gap-2 flex-wrap">
            <div className="flex-1 min-w-48">
              <Input placeholder="https://github.com/owner/repo" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} />
            </div>
            <Button type="submit" variant="primary" size="sm" loading={starting} disabled={jobActive}>
              {t('transfer.startImport', 'Start Import')}
            </Button>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">{t('transfer.importHint', 'HTTPS Public Repos Only. Targets Empty Repositories. No Credentials Stored.')}</p>
          {job && (
            <div className="text-sm text-[var(--color-text-secondary)]">
              <ReadOnlyField label={t('transfer.importStatus', 'Latest Import Status')} value={`${job.status}${job.error ? ` — ${job.error}` : ''}${job.status === 'done' ? ` (${job.importedRefs} refs)` : ''}`} />
              {jobActive && (
                <Button variant="danger" size="sm" onClick={() => void cancel()} className="mt-2">
                  {t('transfer.cancelImport', 'Cancel Import')}
                </Button>
              )}
            </div>
          )}
        </form>

        <form onSubmit={saveMirror} className="space-y-2">
          <Label>{t('transfer.mirror', 'Scheduled Pull Mirror (Fast-Forward Only)')}</Label>
          <div className="flex gap-2 flex-wrap">
            <div className="flex-1 min-w-48">
              <Input placeholder="https://github.com/owner/repo" value={mirrorUrl} onChange={(e) => setMirrorUrl(e.target.value)} />
            </div>
            <Select aria-label={t('transfer.interval', 'Interval')} value={intervalMinutes} onChange={(e) => setIntervalMinutes(Number(e.target.value))}>
              {MIRROR_INTERVALS.map((m) => (
                <option key={m} value={m}>
                  {intervalLabel(m)}
                </option>
              ))}
            </Select>
            <Button type="submit" variant="primary" size="sm" loading={savingMirror}>
              {t('common.saveChanges', 'Save Changes')}
            </Button>
          </div>
          {mirror && (
            <div className="flex items-center gap-2 flex-wrap text-sm text-[var(--color-text-secondary)]">
              <span>
                {mirror.enabled ? t('transfer.mirrorOn', 'Mirror Enabled.') : t('transfer.mirrorOff', 'Mirror Disabled (Auto-Disabled After Repeated Failures).')}
                {mirror.lastRunAt ? ` ${t('transfer.lastRun', 'Last Run:')} ${new Date(mirror.lastRunAt * 1000).toLocaleString()} (${mirror.lastStatus ?? '—'})` : ''}
                {mirror.lastError ? ` — ${mirror.lastError}` : ''}
              </span>
              <Button size="sm" variant="secondary" onClick={() => void syncNow()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t('transfer.syncNow', 'Sync Now')}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => void toggleMirror()}>
                {mirror.enabled ? t('transfer.disable', 'Disable') : t('transfer.enable', 'Enable')}
              </Button>
              <Button size="sm" variant="danger" onClick={() => void removeMirror()}>
                {t('transfer.remove', 'Remove')}
              </Button>
            </div>
          )}
        </form>

        <div className="space-y-2">
          <Label>{t('transfer.export', 'Export (Pack + Refs)')}</Label>
          <div>
            <Button size="sm" variant="secondary" loading={exporting} onClick={() => void doExport()}>
              <Download className="h-3.5 w-3.5" />
              {t('transfer.downloadExport', 'Download Export')}
            </Button>
          </div>
          <p className="text-xs text-[var(--color-text-muted)]">{t('transfer.exportHint', 'Bounded Size. Restore With git unpack-objects + update-ref.')}</p>
        </div>
      </div>
    </Card>
  );
}
