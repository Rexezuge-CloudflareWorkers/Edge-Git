import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

const badgeVariants = cva('inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium shrink-0', {
  variants: {
    variant: {
      success: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)]',
      error: 'bg-[var(--color-error-bg)] text-[var(--color-error-text)]',
      warning: 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
      info: 'bg-[var(--color-info-bg)] text-[var(--color-info-text)]',
      neutral: 'bg-[var(--color-neutral-bg)] text-[var(--color-neutral-text)]',
    },
  },
  defaultVariants: { variant: 'neutral' },
});

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>['variant']>;

export function Badge({
  className,
  variant,
  children,
}: { className?: string; children: React.ReactNode } & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)}>{children}</span>;
}

export function VisibilityBadge({ isPrivate }: { isPrivate: boolean }) {
  return <Badge variant={isPrivate ? 'warning' : 'success'}>{isPrivate ? 'Private' : 'Public'}</Badge>;
}

export function IssueStatusBadge({ status }: { status: string }) {
  return <Badge variant={status === 'open' ? 'success' : 'neutral'}>{status === 'open' ? 'Open' : 'Closed'}</Badge>;
}
