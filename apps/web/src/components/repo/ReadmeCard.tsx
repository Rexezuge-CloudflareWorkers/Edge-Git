import { useTranslation } from 'react-i18next';
import { Card } from '../ui/Card';
import { Markdown } from '../shared/Markdown';

export function ReadmeCard({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <Card>
      <h2 className="text-base font-semibold text-[var(--color-text-primary)] mb-3">{t('repos.readme', 'README')}</h2>
      <Markdown content={text} />
    </Card>
  );
}
