import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from '../ConfirmDialog';
import type { ConfirmDialogProps } from '../ConfirmDialog';

afterEach(cleanup);

function renderConfirm(props: Partial<ConfirmDialogProps> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Unfriend Ada Brennan?"
      message="You can send a new friend request later."
      confirmLabel="unfriend"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel };
}

describe('ConfirmDialog', () => {
  it('is an alertdialog named by the question and described by the consequence (F-50)', () => {
    renderConfirm();

    const dialog = screen.getByRole('alertdialog', { name: 'Unfriend Ada Brennan?' });
    expect(dialog).toHaveAccessibleDescription('You can send a new friend request later.');
  });

  it('starts on "cancel", the least destructive choice', () => {
    renderConfirm();

    expect(screen.getByRole('button', { name: 'cancel' })).toHaveFocus();
  });

  it('confirms and cancels', async () => {
    const user = userEvent.setup();
    const { onConfirm, onCancel } = renderConfirm();

    await user.click(screen.getByRole('button', { name: 'unfriend' }));
    expect(onConfirm).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: 'cancel' }));
    await user.click(screen.getByRole('button', { name: 'close' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });

  it('disables the confirm button while the action runs (F-51)', () => {
    renderConfirm({ pending: true });

    const confirm = screen.getByRole('button', { name: 'unfriend' });
    expect(confirm).toBeDisabled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
  });

  it('keeps the dialog open with the error of a failed action (F-53)', () => {
    renderConfirm({ error: 'The friendship could not be ended. Please try again.' });

    expect(screen.getByRole('alert')).toHaveTextContent('The friendship could not be ended. Please try again.');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('works without a message', () => {
    renderConfirm({ message: undefined, title: 'Delete this post?', confirmLabel: 'delete post' });

    const dialog = screen.getByRole('alertdialog', { name: 'Delete this post?' });
    expect(dialog).not.toHaveAttribute('aria-describedby');
    expect(screen.getByRole('button', { name: 'delete post' })).toBeEnabled();
  });
});
