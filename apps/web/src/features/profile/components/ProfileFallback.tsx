import { errorMessage } from '../../../shared/api/problem';
import { ErrorState } from '../../../shared/ui/ErrorState';
import { LoadingState } from '../../../shared/ui/LoadingState';
import { VisuallyHidden } from '../../../shared/ui/VisuallyHidden';
import './ProfileFallback.css';

export interface ProfileFallbackProps {
  isError: boolean;
  error: unknown;
  /** The error state's title, e.g. "Your profile could not be loaded." */
  errorTitle: string;
  onRetry: () => void;
  retrying: boolean;
}

/**
 * What a profile page shows before it has a user (F-25, B-82): "loading profile…", or on an error the page's `<h1>`
 * (for assistive technology only, so the page still has its heading) and the error with "try again". Never a blank
 * page.
 */
export function ProfileFallback({ isError, error, errorTitle, onRetry, retrying }: ProfileFallbackProps) {
  if (!isError) {
    return <LoadingState label="loading profile…" />;
  }
  return (
    <>
      <h1 className="profile-fallback__title">
        <VisuallyHidden>Profile</VisuallyHidden>
      </h1>
      <ErrorState title={errorTitle} message={errorMessage(error)} onRetry={onRetry} retrying={retrying} />
    </>
  );
}
