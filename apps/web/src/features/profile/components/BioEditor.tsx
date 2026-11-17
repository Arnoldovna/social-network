import { Bio, BIO_MAX } from '@app/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { bodyFieldErrors, errorMessage } from '../../../shared/api/problem';
import { Button } from '../../../shared/ui/Button';
import { FieldError } from '../../../shared/ui/FieldError';
import { TextArea } from '../../../shared/ui/TextArea';
import { useUpdateMeMutation } from '../profile.api';
import './BioEditor.css';

/** The form validates with the shared `Bio` rule (trimmed, ≤ 1,000 characters, blank → `null`; F-29, ADR-0012). */
const BioForm = z.object({ bio: Bio });
type BioFormInput = z.input<typeof BioForm>;
type BioFormOutput = z.output<typeof BioForm>;

const SAVED_MESSAGE = 'Your bio was saved.';

export interface BioEditorProps {
  /** The signed-in user's bio from the `getMe` cache; `null` when there is none. */
  bio: string | null;
}

/**
 * The own bio (F-26–F-32): shown as plain text with its line breaks (F-32), or "You have not written a bio yet." with
 * "add bio" (F-26). "edit bio" opens a labelled textarea **prefilled from the current bio** (F-27, B-77), with a live
 * character counter (F-29), "save" and "cancel".
 *
 * - Saving a value that equals the current bio after trimming sends nothing and keeps it (F-28, B-77). Saving an
 *   emptied field clears the bio, which only happens after that explicit change.
 * - Cancel (or Escape in the textarea) drops the draft and returns focus to the edit button (F-30).
 * - A failed save keeps the editor open with the draft and shows the error; a 422 lands on the field (F-31).
 * - A successful save closes the editor, returns focus to the edit button and says so in a polite live region.
 */
export function BioEditor({ bio }: BioEditorProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [status, setStatus] = useState('');
  const [updateMe, { isLoading: isSaving }] = useUpdateMeMutation();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const formErrorId = useId();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    control,
    formState: { errors },
  } = useForm<BioFormInput, unknown, BioFormOutput>({
    resolver: zodResolver(BioForm),
    defaultValues: { bio: bio ?? '' },
  });

  // Back on the toggle button after the editor closed (F-30), once it is in the DOM again.
  useEffect(() => {
    if (!isEditing && restoreFocus.current) {
      restoreFocus.current = false;
      toggleRef.current?.focus();
    }
  }, [isEditing]);

  const draft = useWatch({ control, name: 'bio' });

  function open() {
    // Always start from the bio as it is now, never from an older draft or an empty string (B-77).
    reset({ bio: bio ?? '' });
    setStatus('');
    setIsEditing(true);
  }

  function close() {
    restoreFocus.current = true;
    setIsEditing(false);
  }

  function cancel() {
    reset({ bio: bio ?? '' });
    close();
  }

  async function save({ bio: nextBio }: BioFormOutput) {
    if (nextBio === bio) {
      // Nothing changed after trimming (F-28): no request, the stored bio stays as it is.
      close();
      return;
    }
    try {
      await updateMe({ bio: nextBio }).unwrap();
      setStatus(SAVED_MESSAGE);
      close();
    } catch (error) {
      // F-31: the editor stays open with the draft. A field error from a 422 goes under the textarea.
      const fieldMessage = bodyFieldErrors(error)['bio'];
      setError(fieldMessage === undefined ? 'root.server' : 'bio', {
        type: 'server',
        message: fieldMessage ?? errorMessage(error, 'Your bio could not be saved. Please try again.'),
      });
    }
  }

  function onTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape' && !isSaving) {
      event.preventDefault();
      cancel();
    }
  }

  const formError = errors.root?.['server']?.message;

  return (
    <div className="bio-editor">
      {isEditing ? (
        <form
          className="bio-editor__form"
          noValidate
          aria-describedby={formError === undefined ? undefined : formErrorId}
          onSubmit={(event) => void handleSubmit(save)(event)}
        >
          <TextArea
            {...register('bio')}
            className="bio-editor__field"
            label="bio"
            rows={6}
            autoFocus
            error={errors.bio?.message}
            characterCount={{ length: draft.trim().length, max: BIO_MAX }}
            onKeyDown={onTextareaKeyDown}
          />
          <FieldError id={formErrorId}>{formError}</FieldError>
          <div className="bio-editor__actions">
            <Button type="submit" variant="outlined" disabled={isSaving} aria-busy={isSaving ? true : undefined}>
              {isSaving ? 'saving…' : 'save'}
            </Button>
            <Button onClick={cancel} disabled={isSaving}>
              cancel
            </Button>
          </div>
        </form>
      ) : (
        <>
          {bio === null ? (
            <p className="bio-editor__text bio-editor__text--empty">You have not written a bio yet.</p>
          ) : (
            <p className="bio-editor__text">{bio}</p>
          )}
          <Button ref={toggleRef} className="bio-editor__toggle" onClick={open}>
            {bio === null ? 'add bio' : 'edit bio'}
          </Button>
        </>
      )}
      <p className="bio-editor__status" role="status">
        {status}
      </p>
    </div>
  );
}
