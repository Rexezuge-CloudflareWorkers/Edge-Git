import type { ReactNode } from 'react';

// The frame is the kit's (`@rexezuge/web`'s `ModalShell`): it renders in a
// portal, closes on Escape, puts the dialog role on the *panel* rather than on
// the backdrop that contains it, and owns the close button.
//
// What stays here is what the kit does not carry: this repo's header, body and
// row helpers, and the wide-modal width. The kit's frame draws no chrome of
// its own beyond the backdrop and the panel, so those are ours to keep.
//
// The close button moved: it was an icon in the header, and is now the kit's
// corner button. The header therefore no longer draws one, and keeps room for
// it.

export const WIDE_MODAL_CLASS = 'w-full max-w-2xl max-h-[82vh] overflow-hidden mx-4';

export function ModalHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 pl-5 pr-24 py-4 border-b border-[var(--color-border)]">
      <h2 className="text-base font-semibold text-[var(--color-text-primary)]">{title}</h2>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  );
}

export function ModalBody({ children }: { children: ReactNode }) {
  return <div className="overflow-y-auto p-5 space-y-2.5 max-h-[calc(82vh-4rem)]">{children}</div>;
}

export function ModalRow({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-base)] p-4">{children}</div>;
}

export function ModalEmpty({ message }: { message: string }) {
  return <div className="text-center text-[var(--color-text-muted)] py-10 text-sm">{message}</div>;
}

export {ModalShell} from '@rexezuge/web';
