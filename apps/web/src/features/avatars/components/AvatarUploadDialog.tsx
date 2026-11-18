import type { Me } from '@app/shared';
import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, RefObject, SubmitEvent, SyntheticEvent } from 'react';

import { tokenList } from '../../../shared/lib/token-list';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { Dialog } from '../../../shared/ui/Dialog';
import { FieldError } from '../../../shared/ui/FieldError';
import { useUploadAvatarMutation } from '../avatars.api';
import {
  AVATAR_ACCEPT,
  AVATAR_FILE_HINT,
  AVATAR_FILE_MESSAGES,
  uploadErrorMessage,
  validateAvatarDimensions,
  validateAvatarFile,
} from '../validate-avatar-file';
import './AvatarUploadDialog.css';

export const AVATAR_DIALOG_TITLE = 'Change profile picture';

export interface AvatarUploadDialogProps {
  /** Owned by the trigger (`AvatarButton`); the dialog opens and closes only with this prop. */
  open: boolean;
  /** Escape, "close", a backdrop click. Closing while an upload runs cancels it (ADR-0012). */
  onClose: () => void;
  /** The server saved the picture; `user` is the new `Me` that is already in the cache. */
  onUploaded: (user: Me) => void;
  /** The signed-in user, for the current picture shown before a file is chosen. */
  user: Me;
}

/**
 * The avatar upload modal (F-34, F-35, F-38; B-96, B-97). Built on the shared native `<dialog>`, so it traps focus,
 * closes with Escape, "close" and a backdrop click, and returns focus to the trigger. The form is mounted only while
 * the dialog is open: every opening starts without a file, and closing mid-upload unmounts it, which aborts the XHR.
 */
export function AvatarUploadDialog({ open, onClose, onUploaded, user }: AvatarUploadDialogProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={AVATAR_DIALOG_TITLE}
      initialFocusRef={fileInputRef}
      className="avatar-upload-dialog__sheet"
    >
      <AvatarUploadForm fileInputRef={fileInputRef} onUploaded={onUploaded} user={user} />
    </Dialog>
  );
}

interface Selection {
  file: File;
  /** `blob:` URL of `file` for the preview, revoked when the selection changes or the form unmounts. */
  previewUrl: string;
}

interface AvatarUploadFormProps {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onUploaded: (user: Me) => void;
  user: Me;
}

function AvatarUploadForm({ fileInputRef, onUploaded, user }: AvatarUploadFormProps) {
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const progressLabelId = useId();

  const [selection, setSelection] = useState<Selection | null>(null);
  /**
   * Name of the file in the input, valid or not. `selection` holds only an uploadable file, so a refused one ("cv.pdf",
   * too large) would otherwise read "no image chosen" next to its own error message.
   */
  const [chosenFileName, setChosenFileName] = useState<string | null>(null);
  /** Why the chosen file cannot be uploaded (browser-side checks); `null` while it may be. */
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  /** Share of the body sent, `0`–`1`, while an upload runs; `null` otherwise. */
  const [progress, setProgress] = useState<number | null>(null);
  const [uploadAvatar, { isLoading, error: uploadError, reset: resetUpload }] = useUploadAvatarMutation();
  const runningUpload = useRef<ReturnType<typeof uploadAvatar> | null>(null);

  // The preview URL belongs to the selection: free it when another file replaces it or the form unmounts.
  useEffect(() => {
    if (selection === null) {
      return undefined;
    }
    const { previewUrl } = selection;
    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [selection]);

  // Closing the dialog unmounts the form: cancel a running upload (ADR-0012). It reads the request current at unmount.
  useEffect(
    () => () => {
      runningUpload.current?.abort();
    },
    [],
  );

  const errorText = fileProblem ?? (uploadError === undefined ? null : uploadErrorMessage(uploadError));
  const canSave = selection !== null && fileProblem === null && !isLoading;

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0] ?? null;
    resetUpload();
    setChosenFileName(file?.name ?? null);
    if (file === null) {
      setSelection(null);
      setFileProblem(null);
      return;
    }
    const check = validateAvatarFile(file);
    if (!check.ok) {
      // No preview for a file that cannot be uploaded: nothing is decoded that the server would refuse.
      setSelection(null);
      setFileProblem(check.message);
      return;
    }
    setSelection({ file, previewUrl: URL.createObjectURL(file) });
    setFileProblem(null);
  };

  // The preview is the first decode of the file, so its natural size mirrors the server's pixel guard (ADR-0010).
  const handlePreviewLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = event.currentTarget;
    const check = validateAvatarDimensions(naturalWidth, naturalHeight);
    if (!check.ok) {
      setFileProblem(check.message);
    }
  };

  // The browser cannot decode it, so neither can the server (it would answer 415).
  const handlePreviewError = () => {
    setFileProblem(AVATAR_FILE_MESSAGES.unsupportedType);
  };

  const handleSubmit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave) {
      return;
    }
    setProgress(0);
    const request = uploadAvatar({ file: selection.file, onProgress: setProgress });
    runningUpload.current = request;
    const result = await request;
    runningUpload.current = null;
    setProgress(null);
    if (result.data !== undefined) {
      onUploaded(result.data.user);
    }
  };

  const showsPreview = selection !== null && fileProblem === null;

  return (
    <form
      className="avatar-upload-dialog"
      noValidate
      onSubmit={(event) => {
        void handleSubmit(event);
      }}
    >
      <div className="avatar-upload-dialog__picture">
        {showsPreview ? (
          <img
            className="avatar-upload-dialog__preview"
            src={selection.previewUrl}
            alt="Preview of your new profile picture"
            onLoad={handlePreviewLoad}
            onError={handlePreviewError}
          />
        ) : (
          <Avatar
            firstName={user.firstName}
            lastName={user.lastName}
            src={user.avatarUrl}
            size="large"
            className="avatar-upload-dialog__current"
          />
        )}
      </div>

      <div className="avatar-upload-dialog__field">
        {/* The native input stays in the tab order and carries every ARIA state; it is only hidden visually. Its label
            comes right after it and is drawn as the outlined button (maw components §7), so the browser's own
            "choose file / no file chosen" text never shows. */}
        <input
          ref={fileInputRef}
          id={inputId}
          className="visually-hidden avatar-upload-dialog__input"
          type="file"
          name="avatar"
          accept={AVATAR_ACCEPT}
          disabled={isLoading}
          aria-invalid={errorText === null ? undefined : true}
          aria-describedby={tokenList(hintId, errorText !== null && errorId)}
          onChange={handleFileChange}
        />
        <label className="avatar-upload-dialog__choose" htmlFor={inputId}>
          choose an image
        </label>
        <p className="avatar-upload-dialog__file-name">{chosenFileName ?? 'no image chosen'}</p>
        <p id={hintId} className="avatar-upload-dialog__hint">
          {AVATAR_FILE_HINT}
        </p>
        <FieldError id={errorId}>{errorText ?? undefined}</FieldError>
      </div>

      {/* Announced once per phase ("uploading…", then "saving…"), not on every percent. */}
      <div className="avatar-upload-dialog__status" role="status">
        {progress === null ? null : (
          <>
            <span id={progressLabelId} className="avatar-upload-dialog__status-label">
              {progress < 1 ? 'uploading…' : 'saving…'}
            </span>
            <progress
              className="avatar-upload-dialog__progress"
              aria-labelledby={progressLabelId}
              max={100}
              value={Math.round(progress * 100)}
            />
          </>
        )}
      </div>

      <div className="avatar-upload-dialog__actions">
        {/* Not `disabled` while uploading: the button has focus then, and a disabled button would drop it. */}
        <Button
          type="submit"
          variant="accent"
          disabled={selection === null || fileProblem !== null}
          aria-disabled={isLoading ? true : undefined}
        >
          save
        </Button>
      </div>
    </form>
  );
}
