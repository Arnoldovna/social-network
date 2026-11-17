import { CreatePostBody, POST_MAX } from '@app/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useForm, useWatch } from 'react-hook-form';

import { bodyFieldErrors, errorMessage } from '../../../shared/api/problem';
import { formatCount } from '../../../shared/lib/format-count';
import { possessive } from '../../../shared/lib/names';
import { Button } from '../../../shared/ui/Button';
import { FieldError } from '../../../shared/ui/FieldError';
import { TextArea } from '../../../shared/ui/TextArea';
import { VisuallyHidden } from '../../../shared/ui/VisuallyHidden';
import { useCreatePostMutation } from '../wall.api';
import './WallComposer.css';

/**
 * The shared schema says "Write something first." for an empty post; its upper bound has no sentence of its own, so
 * this parse supplies one in the maw voice (the limit itself still comes from the contract, F-67).
 */
const resolver = zodResolver(CreatePostBody, {
  error: (issue) =>
    issue.code === 'too_big' ? `Keep your post under ${formatCount(POST_MAX)} characters.` : undefined,
});

export interface WallComposerProps {
  ownerId: number;
  ownerFirstName: string;
}

/**
 * The form to write on a wall (F-66, F-67, F-75): a labelled textarea ("write on Mira's wall") with a character
 * count, a "post" button, and Ctrl+Enter / Cmd+Enter as a shortcut. Rendered only when the server says the viewer may
 * post (`canPostOnWall`, B-90); the server checks again (403 `wall-write-forbidden`).
 *
 * The draft is a controlled field that only this form changes: posts arriving from others never touch it, and it is
 * cleared only after the own post was saved (F-73, B-83). If the user kept typing while the post was being saved, the
 * newer text stays. A failed post keeps the draft and shows the reason.
 */
export function WallComposer({ ownerId, ownerFirstName }: WallComposerProps) {
  const [createPost] = useCreatePostMutation();
  const [status, setStatus] = useState('');
  const [focusRequests, setFocusRequests] = useState(0);
  const {
    register,
    control,
    handleSubmit,
    getValues,
    reset,
    setError,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm({ resolver, defaultValues: { body: '' } });
  const draft = useWatch({ control, name: 'body' });

  const submit = handleSubmit(async ({ body }) => {
    const submittedDraft = getValues('body');
    setStatus('');
    try {
      await createPost({ ownerId, body }).unwrap();
      if (getValues('body') === submittedDraft) {
        reset({ body: '' });
      }
      setStatus('Your post is on the wall.');
    } catch (error: unknown) {
      const fieldMessage = bodyFieldErrors(error)['body'];
      if (fieldMessage === undefined) {
        setError('root.server', { message: errorMessage(error) });
      } else {
        setError('body', { message: fieldMessage });
      }
    }
    setFocusRequests((count) => count + 1);
  });

  // The disabled "post" button drops focus while saving; writing continues in the field. Focused from an effect, once
  // the form has rendered its settled state (calling `setFocus` inside the submit handler left focus on the button).
  useEffect(() => {
    if (focusRequests > 0) {
      setFocus('body');
    }
  }, [focusRequests, setFocus]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!isSubmitting) {
        void submit();
      }
    }
  };

  return (
    <form
      className="wall-composer"
      noValidate
      aria-busy={isSubmitting ? true : undefined}
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <TextArea
        {...register('body')}
        label={`write on ${possessive(ownerFirstName)} wall`}
        hint="Ctrl+Enter or Cmd+Enter posts it."
        rows={3}
        error={errors.body?.message}
        characterCount={{ length: draft.length, max: POST_MAX }}
        className="wall-composer__field"
        onKeyDown={handleKeyDown}
      />
      <div className="wall-composer__actions">
        <Button type="submit" variant="outlined" disabled={isSubmitting} aria-busy={isSubmitting ? true : undefined}>
          {isSubmitting ? 'posting…' : 'post'}
        </Button>
      </div>
      <FieldError>{errors.root?.['server']?.message}</FieldError>
      <VisuallyHidden role="status">{status}</VisuallyHidden>
    </form>
  );
}
