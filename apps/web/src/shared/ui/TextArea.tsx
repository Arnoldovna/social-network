import { useId } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { tokenList } from '../lib/token-list';
import { FieldError } from './FieldError';
import './TextArea.css';

const countFormat = new Intl.NumberFormat('en-GB');

export interface CharacterCount {
  /** Current length of the value (the caller knows it, e.g. from react-hook-form's `watch`). */
  length: number;
  /** The limit from the shared contract (`BIO_MAX`, the wall and chat limits). */
  max: number;
}

export type TextAreaProps = Omit<ComponentPropsWithRef<'textarea'>, 'className' | 'children' | 'aria-invalid'> & {
  /** Visible label above the textarea (F-27, F-75); placeholders are never labels. */
  label: ReactNode;
  hint?: ReactNode;
  error?: string | undefined;
  /** Shows "<n> characters left" (or "<n> characters too many") below the field (F-29). */
  characterCount?: CharacterCount;
  /** BEM element class of the parent block, mixed into the wrapper (layout only). */
  className?: string;
};

function describeCharacterCount({ length, max }: CharacterCount): string {
  const remaining = max - length;
  if (remaining >= 0) {
    return `${countFormat.format(remaining)} ${remaining === 1 ? 'character' : 'characters'} left`;
  }
  const over = -remaining;
  return `${countFormat.format(over)} ${over === 1 ? 'character' : 'characters'} too many`;
}

/**
 * Labelled multi-line input with the maw underline. Every other prop (including `ref`, `name`, `onChange`,
 * `onBlur` and `onKeyDown` for Ctrl/Cmd+Enter) goes to the `<textarea>`.
 */
export function TextArea({
  label,
  hint,
  error,
  characterCount,
  id,
  className,
  rows = 4,
  'aria-describedby': extraDescribedBy,
  ...textareaProps
}: TextAreaProps) {
  const generatedId = useId();
  const textareaId = id ?? generatedId;
  const hintId = `${textareaId}-hint`;
  const countId = `${textareaId}-count`;
  const errorId = `${textareaId}-error`;
  const hasError = error !== undefined && error !== '';
  const hasHint = hint !== undefined && hint !== null && hint !== '';
  const isOverLimit = characterCount !== undefined && characterCount.length > characterCount.max;
  const describedBy = tokenList(
    hasError && errorId,
    hasHint && hintId,
    characterCount !== undefined && countId,
    extraDescribedBy,
  );

  return (
    <div className={tokenList('text-area', className)}>
      <label className="text-area__label" htmlFor={textareaId}>
        {label}
      </label>
      <textarea
        {...textareaProps}
        id={textareaId}
        rows={rows}
        className="text-area__input"
        aria-invalid={hasError ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />
      {hasHint || characterCount !== undefined ? (
        <div className="text-area__meta">
          {hasHint ? (
            <p id={hintId} className="text-area__hint">
              {hint}
            </p>
          ) : null}
          {characterCount !== undefined ? (
            <p id={countId} className={isOverLimit ? 'text-area__count text-area__count--over' : 'text-area__count'}>
              {describeCharacterCount(characterCount)}
            </p>
          ) : null}
        </div>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
