import './LoadingState.css';

export interface LoadingStateProps {
  /** What is loading, lowercase and ending in an ellipsis, e.g. "loading posts…". */
  label?: string;
}

/**
 * The maw loading state: the word "loading…" in meta size, no spinner and no shimmer (maw-design-system §6, §14).
 * `role="status"` announces it politely; a blank screen is never shown (F-25, F-44, F-105).
 */
export function LoadingState({ label = 'loading…' }: LoadingStateProps) {
  return (
    <p className="loading-state" role="status">
      {label}
    </p>
  );
}
