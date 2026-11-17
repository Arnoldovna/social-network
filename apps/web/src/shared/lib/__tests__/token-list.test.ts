import { describe, expect, it } from 'vitest';

import { tokenList } from '../token-list';

describe('tokenList', () => {
  it('joins the tokens that apply with single spaces, in order', () => {
    expect(tokenList('button', 'button--outlined', 'site-header__logout')).toBe(
      'button button--outlined site-header__logout',
    );
  });

  it('skips false, null, undefined and empty parts', () => {
    expect(tokenList('button', false, undefined, null, '', 'card__action')).toBe('button card__action');
  });

  it('takes the result of a condition, as in `outlined && "button--outlined"`', () => {
    const modifier = (outlined: boolean) => outlined && 'button--outlined';
    expect(tokenList('button', modifier(true))).toBe('button button--outlined');
    expect(tokenList('button', modifier(false))).toBe('button');
  });

  it('returns an empty string when nothing applies', () => {
    expect(tokenList(undefined, false, '')).toBe('');
    expect(tokenList()).toBe('');
  });
});
