import { useId, useRef } from 'react';
import type { ReactNode } from 'react';

import { Button } from './Button';
import { Dialog } from './Dialog';
import { FieldError } from './FieldError';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  open: boolean;
  /** The question as a sentence, e.g. "Unfriend Ada Brennan?". */
  title: ReactNode;
  /** One sentence about the consequence, e.g. "You can send a new friend request later." */
  message?: ReactNode;
  /** Lowercase verb, e.g. "unfriend", "delete post". */
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** Called for "cancel", "close", Escape and a backdrop click. */
  onCancel: () => void;
  /** While the action runs, the confirm button is disabled (F-51). */
  pending?: boolean;
  /** A failed action keeps the dialog open with the message (F-53). */
  error?: string | undefined;
}

/**
 * Confirmation before a destructive action (F-50 unfriend, F-71 delete post). An `alertdialog` on the native
 * `<dialog>`; focus starts on "cancel", the least destructive choice (WAI-ARIA APG alert dialog pattern).
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel = 'cancel',
  onConfirm,
  onCancel,
  pending = false,
  error,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const messageId = useId();
  const hasMessage = message !== undefined && message !== null && message !== '';

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      role="alertdialog"
      describedBy={hasMessage ? messageId : undefined}
      initialFocusRef={cancelRef}
      className="confirm-dialog"
    >
      {hasMessage ? (
        <p id={messageId} className="confirm-dialog__message">
          {message}
        </p>
      ) : null}
      <FieldError>{error}</FieldError>
      <div className="confirm-dialog__actions">
        <Button variant="outlined" onClick={onConfirm} disabled={pending} aria-busy={pending ? true : undefined}>
          {confirmLabel}
        </Button>
        <Button ref={cancelRef} onClick={onCancel}>
          {cancelLabel}
        </Button>
      </div>
    </Dialog>
  );
}
