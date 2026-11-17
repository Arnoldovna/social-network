import { useEffect, useEffectEvent, useState } from 'react';
import type { FocusEvent } from 'react';

import { Button } from './Button';
import './Toast.css';

/** maw-design-system §14: a status toast stays at least six seconds. */
export const TOAST_MIN_DURATION_MS = 6000;

export type ToastTone = 'status' | 'error';

/**
 * One occurrence of a toast. A new `id` for every occurrence makes the same sentence shown twice in a row ("Too many
 * requests…") a new toast: announced again, with a fresh timer. Create it with `toastMessage(text)`.
 */
export interface ToastMessage {
  id: number;
  text: string;
}

let lastToastId = 0;

/** A new occurrence of `text`, e.g. `setToast(toastMessage('Your bio is saved.'))`. */
export function toastMessage(text: string): ToastMessage {
  lastToastId += 1;
  return { id: lastToastId, text };
}

export interface ToastProps {
  /** The toast to show; `null` shows nothing (the live regions stay mounted, so the next message is announced). */
  message: ToastMessage | null;
  /** Called by "dismiss" and when the auto-hide time is over. */
  onDismiss: () => void;
  /** `error` is announced assertively, gets the error rule and stays until dismissed. */
  tone?: ToastTone;
  /**
   * Auto-hide after this many milliseconds (at least 6,000), `null` never. Defaults: 6,000 for `status`, `null` for
   * `error`, because an error the user has not read must not disappear (WCAG 2.2.1).
   */
  duration?: number | null;
  dismissLabel?: string;
}

/**
 * A single maw toast, bottom left with a 1px ink border and a "dismiss" text button (maw-design-system §14); no
 * icons, no coloured fill. Auto-hide pauses while the pointer is over it or focus is inside it.
 *
 * Two live regions stay mounted, a polite `status` and an assertive `alert`, and the toast is rendered into the one
 * of its tone. A region's role never changes while it is mounted: screen readers often miss content that arrives in
 * the same update as a role change, and a region added together with its text is often not read at all.
 */
export function Toast({ message, onDismiss, tone = 'status', duration, dismissLabel = 'dismiss' }: ToastProps) {
  const defaultDuration = tone === 'error' ? null : TOAST_MIN_DURATION_MS;
  const requested = duration === undefined ? defaultDuration : duration;
  const hideAfterMs = requested === null ? null : Math.max(requested, TOAST_MIN_DURATION_MS);
  const card =
    message === null || message.text === '' ? null : (
      // Keyed by the occurrence, so a repeated sentence restarts its timer and the hover/focus pause of a previous
      // toast never carries over to the next one.
      <ToastCard
        key={message.id}
        message={message.text}
        tone={tone}
        hideAfterMs={hideAfterMs}
        onDismiss={onDismiss}
        dismissLabel={dismissLabel}
      />
    );

  return (
    <div className="toast-region">
      <div role="status">{tone === 'status' ? card : null}</div>
      <div role="alert">{tone === 'error' ? card : null}</div>
    </div>
  );
}

interface ToastCardProps {
  message: string;
  tone: ToastTone;
  hideAfterMs: number | null;
  onDismiss: () => void;
  dismissLabel: string;
}

function ToastCard({ message, tone, hideAfterMs, onDismiss, dismissLabel }: ToastCardProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  // The caller usually passes a new arrow function on every render; that must not restart the timer.
  const dismissAfterTimeout = useEffectEvent(() => {
    onDismiss();
  });

  useEffect(() => {
    if (hideAfterMs === null || paused) {
      return undefined;
    }
    // A pause restarts the full time, so the reader always gets at least the minimum after looking away.
    const timer = setTimeout(dismissAfterTimeout, hideAfterMs);
    return () => {
      clearTimeout(timer);
    };
  }, [hideAfterMs, paused]);

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
      setFocused(false);
    }
  };

  return (
    <div
      className={tone === 'error' ? 'toast toast--error' : 'toast'}
      onPointerEnter={() => {
        setHovered(true);
      }}
      onPointerLeave={() => {
        setHovered(false);
      }}
      onFocus={() => {
        setFocused(true);
      }}
      onBlur={handleBlur}
    >
      <p className="toast__message">{message}</p>
      <Button onClick={onDismiss}>{dismissLabel}</Button>
    </div>
  );
}
