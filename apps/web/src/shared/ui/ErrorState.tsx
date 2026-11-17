import { Button } from './Button';
import './ErrorState.css';

export interface ErrorStateProps {
  /** What happened, as one sentence. */
  title?: string;
  /** What to do next, as one sentence (maw-design-system §10); e.g. the mapped problem+json detail. */
  message?: string;
  /** Usually the query's `refetch` (ADR-0012); without it no button is shown. */
  onRetry?: () => void;
  /** Disables the button while the retry runs. */
  retrying?: boolean;
  retryLabel?: string;
}

/**
 * The error state of a data view (F-105, OVERVIEW §11): a sentence in ink behind a 2px error rule, one more sentence
 * and a "try again" text button. `role="alert"` announces it when it replaces the loading state.
 */
export function ErrorState({
  title = 'This could not be loaded.',
  message = 'Check your connection, then try again.',
  onRetry,
  retrying = false,
  retryLabel = 'try again',
}: ErrorStateProps) {
  return (
    <div className="error-state" role="alert">
      <p className="error-state__title">{title}</p>
      <p className="error-state__text">{message}</p>
      {onRetry === undefined ? null : (
        <Button onClick={onRetry} disabled={retrying} aria-busy={retrying ? true : undefined}>
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
