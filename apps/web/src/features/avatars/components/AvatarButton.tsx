import { useState } from 'react';

import { tokenList } from '../../../shared/lib/token-list';
import { useCurrentUser } from '../../../shared/session/use-current-user';
import { Avatar } from '../../../shared/ui/Avatar';
import { Toast, toastMessage } from '../../../shared/ui/Toast';
import type { ToastMessage } from '../../../shared/ui/Toast';
import { VisuallyHidden } from '../../../shared/ui/VisuallyHidden';
import { AvatarUploadDialog } from './AvatarUploadDialog';
import './AvatarButton.css';

/** The accessible name F-33 fixes; visible on the profile, announced only in the header. */
export const AVATAR_BUTTON_LABEL = 'Change profile picture';

export const AVATAR_SAVED_MESSAGE = 'Your profile picture is saved.';

export interface AvatarButtonProps {
  /** `header`: the small square in the site header; `profile`: the large picture on `/` with a visible label. */
  variant: 'header' | 'profile';
}

/**
 * The signed-in user's picture as a real `<button>` named "Change profile picture" that opens the upload dialog (F-33,
 * B-103; the legacy `<img onClick>` was neither focusable nor named). The picture inside is decorative, because the
 * button's name already says what it is for. It reads the user from the `getMe` cache, so a new upload re-renders it
 * at once (F-37); a visitor gets nothing.
 *
 * Success is announced by a status toast: the dialog closes and focus returns to this button, so without it a screen
 * reader user would not learn that the save worked.
 */
export function AvatarButton({ variant }: AvatarButtonProps) {
  const user = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  if (user === null) {
    return null;
  }

  const isHeader = variant === 'header';

  return (
    <>
      <button
        type="button"
        className={tokenList('avatar-button', isHeader ? 'avatar-button--header' : 'avatar-button--profile')}
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Avatar
          firstName={user.firstName}
          lastName={user.lastName}
          src={user.avatarUrl}
          size={isHeader ? 'small' : 'large'}
          decorative
          className="avatar-button__picture"
        />
        {isHeader ? (
          <VisuallyHidden>{AVATAR_BUTTON_LABEL}</VisuallyHidden>
        ) : (
          <span className="avatar-button__label">{AVATAR_BUTTON_LABEL.toLowerCase()}</span>
        )}
      </button>
      <AvatarUploadDialog
        open={open}
        onClose={() => {
          setOpen(false);
        }}
        onUploaded={() => {
          setOpen(false);
          setToast(toastMessage(AVATAR_SAVED_MESSAGE));
        }}
        user={user}
      />
      <Toast
        message={toast}
        onDismiss={() => {
          setToast(null);
        }}
      />
    </>
  );
}
