import type { ComponentPropsWithRef } from 'react';

import { tokenList } from '../lib/token-list';
import './Button.css';

/**
 * maw button patterns (maw-design-system §6):
 * - `text`: pattern A, text with a 1px underline (2px on hover); the default for most actions.
 * - `outlined`: pattern B, 1px ink rectangle that inverts on hover; primary form submits.
 * - `accent`: pattern B on the rose field; at most once per view.
 */
export type ButtonVariant = 'text' | 'outlined' | 'accent';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: ButtonVariant;
};

/**
 * A native `<button>` (F-102) with `type="button"` by default, so it never submits a form by accident; pass
 * `type="submit"` explicitly. `className` mixes in a BEM element class of the parent block (layout only).
 * Labels are lowercase and start with a verb ("add friend", "save").
 */
export function Button({ variant = 'text', type = 'button', className, ...buttonProps }: ButtonProps) {
  return (
    <button
      {...buttonProps}
      type={type}
      className={tokenList(
        'button',
        variant === 'outlined' && 'button--outlined',
        variant === 'accent' && 'button--outlined button--accent',
        className,
      )}
    />
  );
}
