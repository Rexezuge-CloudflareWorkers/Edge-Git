import { useTranslation } from 'react-i18next';
import { Tag } from 'lucide-react';
import type { TagInfo } from '../../types';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Select } from '../ui/Input';

export function TagPicker({ tags, value, onChange }: { tags: TagInfo[]; value: string; onChange: (ref: string) => void }) {
  const { t } = useTranslation();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('repos.tags', 'Tags')} disabled={tags.length === 0}>
      <option value="">{tags.length === 0 ? t('repos.noTags', 'No Tags') : t('repos.tags', 'Tags')}</option>
      {tags.map((tg) => (
        <option key={tg.ref} value={tg.ref}>
          {tg.name}
        </option>
      ))}
    </Select>
  );
}

export function TagsCard({ tags, onSelect }: { tags: TagInfo[]; onSelect: (ref: string) => void }) {
  const { t } = useTranslation();
  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-base font-semibold text-[var(--color-text-primary)] inline-flex items-center gap-1.5">
          <Tag className="h-4 w-4 text-[var(--color-text-muted)]" />
          {t('repos.tags', 'Tags')}
        </h2>
        <Badge variant="neutral">{tags.length}</Badge>
      </div>
      {tags.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">{t('repos.noTags', 'No Tags Yet.')}</p>
      ) : (
        <ul className="space-y-2.5">
          {tags.map((tg) => (
            <li key={tg.ref} className="text-sm min-w-0">
              <button
                type="button"
                className="w-full text-left hover:underline text-[var(--color-text-primary)] truncate font-mono text-xs"
                onClick={() => onSelect(tg.ref)}
              >
                {tg.name}
              </button>
              <p className="text-xs text-[var(--color-text-muted)]">
                <code className="font-mono">{(tg.peeledOid ?? tg.oid).slice(0, 7)}</code>
                {' · '}
                {tg.type === 'annotated' ? t('repos.annotated', 'Annotated') : t('repos.lightweight', 'Lightweight')}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
