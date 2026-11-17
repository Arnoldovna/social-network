/** A part of a token list: a token, or a falsy value for a token that does not apply. */
export type TokenListPart = string | false | null | undefined;

/**
 * A space-separated DOM token list (`class`, `aria-describedby`) from the parts that apply, in order:
 * `tokenList('button', outlined && 'button--outlined', className)`. `false`, `null`, `undefined` and empty strings are
 * skipped, so optional modifiers and an absent `className` prop leave no stray spaces. Returns `''` when nothing
 * applies; callers that must omit an empty attribute (`aria-describedby`) check for that.
 */
export function tokenList(...parts: readonly TokenListPart[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' ');
}
