import { useId } from 'react';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { tokenList } from '../lib/token-list';
import { FieldError } from './FieldError';
import './TextField.css';

export type TextFieldProps = Omit<ComponentPropsWithRef<'input'>, 'className' | 'children' | 'aria-invalid'> & {
  /** Visible label above the input; placeholders are never labels (maw-design-system §7). */
  label: ReactNode;
  /** Short help text below the input, linked with `aria-describedby`. */
  hint?: ReactNode;
  /** Error message; sets `aria-invalid` and is linked with `aria-describedby`. */
  error?: string | undefined;
  /** BEM element class of the parent block, mixed into the wrapper (layout only). */
  className?: string;
};

/**
 * Labelled single-line input with the maw underline. Every other prop (including `ref`, `name`, `onChange` and
 * `onBlur` from react-hook-form's `register()`) goes to the `<input>`.
 */
export function TextField({
  label,
  hint,
  error,
  id,
  className,
  type = 'text',
  'aria-describedby': extraDescribedBy,
  ...inputProps
}: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const hasError = error !== undefined && error !== '';
  const hasHint = hint !== undefined && hint !== null && hint !== '';
  // The error is read first, then the hint, then anything the caller links itself.
  const describedBy = tokenList(hasError && errorId, hasHint && hintId, extraDescribedBy);

  return (
    <div className={tokenList('text-field', className)}>
      <label className="text-field__label" htmlFor={inputId}>
        {label}
      </label>
      <input
        {...inputProps}
        id={inputId}
        type={type}
        className="text-field__input"
        aria-invalid={hasError ? true : undefined}
        aria-describedby={describedBy === '' ? undefined : describedBy}
      />
      {hasHint ? (
        <p id={hintId} className="text-field__hint">
          {hint}
        </p>
      ) : null}
      <FieldError id={errorId}>{error}</FieldError>
    </div>
  );
}
