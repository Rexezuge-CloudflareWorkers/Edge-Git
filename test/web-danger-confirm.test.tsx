// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string, vars?: Record<string, string>) => {
      let text = fallback ?? key;
      for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{{${k}}}`, v);
      return text;
    },
  }),
}));

import { TypeToConfirmModal } from '../apps/web/src/components/modals/TypeToConfirmModal';

function renderModal() {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <TypeToConfirmModal
      title="Delete Repository"
      description="Permanently Deletes Everything."
      expectedName="alice/demo"
      confirmLabel="Delete Repository"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { onConfirm, onCancel };
}

describe('danger zone type-to-confirm modal', () => {
  it('shows the expected name with a copy button', () => {
    renderModal();
    expect(screen.getByText('alice/demo')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy To Clipboard' })).toBeTruthy();
  });

  it('keeps confirm disabled until the exact name is typed', () => {
    const { onConfirm } = renderModal();
    const confirm = screen.getByRole('button', { name: 'Delete Repository' });
    const input = screen.getByPlaceholderText('alice/demo');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'alice/demo-typo' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(input, { target: { value: 'alice/demo' } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('copies the name without throwing when clipboard is unavailable', () => {
    renderModal();
    const copy = screen.getByRole('button', { name: 'Copy To Clipboard' });
    expect(() => fireEvent.click(copy)).not.toThrow();
  });
});
