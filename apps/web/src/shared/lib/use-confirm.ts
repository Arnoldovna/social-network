import { useRef, useState } from 'react';

import { errorMessage } from '../api/problem';
import type { ConfirmDialogProps } from '../ui/ConfirmDialog';

type ConfirmState<T> = { open: false } | { open: true; target: T; pending: boolean; error: string | undefined };

export interface UseConfirmResult<T> {
  /** What the open dialog is about (the post, the friend), `undefined` while closed. */
  target: T | undefined;
  /** Opens the confirmation for `target`, e.g. from a "delete post" button. */
  request: (target: T) => void;
  /** Spread into `<ConfirmDialog>` next to its title and labels. */
  dialogProps: Pick<ConfirmDialogProps, 'open' | 'pending' | 'error' | 'onConfirm' | 'onCancel'>;
}

export interface UseConfirmOptions<T> {
  /** Runs after `action` succeeded and the dialog closed, e.g. to move focus or announce the result. */
  onConfirmed?: (target: T) => void;
}

/**
 * State for confirming a destructive action (F-50 unfriend, F-71 delete post) with `<ConfirmDialog>`:
 * `request(target)` opens it; "confirm" runs `action(target)` (typically `mutation(arg).unwrap()`) with the button
 * disabled while it runs (F-51); success closes it; a failure keeps it open with the error's message, and nothing
 * else changes (F-53). Closing the dialog while the action runs discards that action's outcome, so a late answer can
 * never reopen or overwrite a newer confirmation.
 */
export function useConfirm<T>(
  action: (target: T) => Promise<unknown>,
  { onConfirmed }: UseConfirmOptions<T> = {},
): UseConfirmResult<T> {
  const [state, setState] = useState<ConfirmState<T>>({ open: false });
  /** Bumped on every open, close and confirm; an action's result only applies while it is still the latest. */
  const attempt = useRef(0);

  const request = (target: T) => {
    attempt.current += 1;
    setState({ open: true, target, pending: false, error: undefined });
  };

  const onCancel = () => {
    attempt.current += 1;
    setState({ open: false });
  };

  const onConfirm = () => {
    if (!state.open || state.pending) {
      return;
    }
    const { target } = state;
    attempt.current += 1;
    const current = attempt.current;
    setState({ open: true, target, pending: true, error: undefined });

    action(target).then(
      () => {
        if (attempt.current !== current) {
          return;
        }
        setState({ open: false });
        onConfirmed?.(target);
      },
      (error: unknown) => {
        if (attempt.current !== current) {
          return;
        }
        setState({ open: true, target, pending: false, error: errorMessage(error) });
      },
    );
  };

  return {
    target: state.open ? state.target : undefined,
    request,
    dialogProps: {
      open: state.open,
      pending: state.open && state.pending,
      error: state.open ? state.error : undefined,
      onConfirm,
      onCancel,
    },
  };
}
