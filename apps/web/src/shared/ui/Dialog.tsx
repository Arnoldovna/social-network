import { useEffect, useId, useReducer, useRef } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent, ReactNode, RefObject, SyntheticEvent } from 'react';

import { tokenList } from '../lib/token-list';
import { Button } from './Button';
import './Dialog.css';

export interface DialogProps {
  /** The caller owns the state; the dialog opens and closes with this prop, and only with it. */
  open: boolean;
  /**
   * Called for Escape, the "close" button, a backdrop click and any other native close. The dialog stays open until
   * the caller sets `open` to `false`, so a caller may keep it open (e.g. while a save is pending).
   */
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Focused after opening. Without it the browser focuses the first focusable element (the "close" button). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** `alertdialog` for confirmations that interrupt the user (ConfirmDialog). */
  role?: 'dialog' | 'alertdialog';
  /** Id of the element that describes the dialog (the question of a confirmation). */
  describedBy?: string;
  closeLabel?: string;
  /** BEM element class of the parent block, mixed into the `<dialog>` (sizing only). */
  className?: string;
}

/**
 * Modal on the native `<dialog>` (F-34): `showModal()` makes the rest of the page inert and traps focus, Escape and a
 * click on the backdrop ask the caller to close it, and focus returns to the element that was focused before it
 * opened. The content is only mounted while open, so forms inside start fresh every time.
 *
 * `open` is the single source of truth. Escape's `cancel` is prevented and reported as `onClose`, so the browser does
 * not close the dialog behind the caller's back. Where it closes anyway (a `cancel` the browser makes uncancelable,
 * `form method="dialog"`), the dialog reports it and shows itself again if the caller keeps `open`.
 *
 * A modal owns Escape: its keydown stops at the `<dialog>`, so a key handler of an ancestor (the header menu around
 * the avatar dialog) never reacts to it or prevents the default that turns it into the dialog's `cancel`. Ancestors
 * therefore need no knowledge of dialogs inside them.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  initialFocusRef,
  role,
  describedBy,
  closeLabel = 'close',
  className,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Set while the effect closes the dialog itself, so that native `close` event is not reported as a user close.
  const closingFromProps = useRef(false);
  const pressStartedOnBackdrop = useRef(false);
  // Bumped by every native close it reports: if the caller keeps `open`, the effect runs again and reopens it.
  const [nativeCloses, reportNativeClose] = useReducer((count: number) => count + 1, 0);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || dialog === null) {
      return undefined;
    }

    const returnFocusTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) {
      dialog.showModal();
    }
    initialFocusRef?.current?.focus();

    return () => {
      if (dialog.open) {
        closingFromProps.current = true;
        dialog.close();
      }
      if (returnFocusTo?.isConnected === true) {
        returnFocusTo.focus();
      }
    };
  }, [open, initialFocusRef, nativeCloses]);

  const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    // An uncancelable `cancel` (Chrome limits repeated Escape) is followed by `close`, which reports it.
    if (event.cancelable) {
      event.preventDefault();
      onClose();
    }
  };

  const handleNativeClose = () => {
    // Browsers fire `close` asynchronously, so the flag is consumed here rather than reset in the effect.
    if (closingFromProps.current) {
      closingFromProps.current = false;
      return;
    }
    onClose();
    // Re-render even if the caller ignores `onClose`: the effect then reopens the dialog while `open` is still true.
    reportNativeClose();
  };

  // Only the propagation stops; the default stays, so the browser still turns this Escape into `cancel`.
  const keepEscapeInside = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
    }
  };

  // The <dialog> has no padding, so its header and body fill the box: a press whose target is the <dialog> itself
  // landed on the backdrop.
  // Press and release must both be there: a text selection dragged out of the sheet must not close the dialog.
  const handlePointerDown = (event: PointerEvent<HTMLDialogElement>) => {
    pressStartedOnBackdrop.current = event.target === event.currentTarget;
  };
  const handleClick = (event: MouseEvent<HTMLDialogElement>) => {
    const isBackdropClick = pressStartedOnBackdrop.current && event.target === event.currentTarget;
    pressStartedOnBackdrop.current = false;
    if (isBackdropClick) {
      onClose();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className={tokenList('dialog', className)}
      role={role}
      aria-labelledby={titleId}
      aria-describedby={describedBy}
      onCancel={handleCancel}
      onClose={handleNativeClose}
      onKeyDown={keepEscapeInside}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
    >
      {open ? (
        <>
          <div className="dialog__header">
            <h2 id={titleId} className="dialog__title">
              {title}
            </h2>
            <Button onClick={onClose}>{closeLabel}</Button>
          </div>
          <div className="dialog__body">{children}</div>
        </>
      ) : null}
    </dialog>
  );
}
