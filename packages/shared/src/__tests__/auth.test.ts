import { describe, expect, it } from 'vitest';

import { AuthResponse, CsrfTokenResponse, LoginBody, RegisterBody } from '../index.js';

const valid = {
  firstName: 'Mira',
  lastName: 'Novak',
  email: 'mira.novak@example.com',
  password: 'correct horse battery',
};

function messages(result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) {
  return (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
}

// B-09: the server validates registration with the same schema the form uses.
describe('RegisterBody', () => {
  it('B-09: accepts a valid registration', () => {
    expect(RegisterBody.parse(valid)).toEqual(valid);
  });

  it('B-09: reports every missing field together', () => {
    const result = RegisterBody.safeParse({});
    expect(result.success).toBe(false);
    expect(messages(result).map((issue) => issue.path)).toEqual(['firstName', 'lastName', 'email', 'password']);
  });

  describe('names (F-07)', () => {
    it('trims first and last name', () => {
      expect(RegisterBody.parse({ ...valid, firstName: '  Mira ', lastName: '\tNovak\n' })).toMatchObject({
        firstName: 'Mira',
        lastName: 'Novak',
      });
    });

    it.each(['', '   '])('rejects the empty or blank first name %j with a readable message', (firstName) => {
      expect(messages(RegisterBody.safeParse({ ...valid, firstName }))).toEqual([
        { path: 'firstName', message: 'Please enter your first name.' },
      ]);
    });

    it('rejects a blank last name with a readable message', () => {
      expect(messages(RegisterBody.safeParse({ ...valid, lastName: ' ' }))).toEqual([
        { path: 'lastName', message: 'Please enter your last name.' },
      ]);
    });

    it('accepts 100 characters and rejects 101 (after trimming)', () => {
      expect(RegisterBody.safeParse({ ...valid, firstName: ` ${'a'.repeat(100)} ` }).success).toBe(true);
      expect(RegisterBody.safeParse({ ...valid, lastName: 'a'.repeat(101) }).success).toBe(false);
    });
  });

  describe('email (F-08)', () => {
    it('trims and lower-cases the address', () => {
      expect(RegisterBody.parse({ ...valid, email: '  Mira.Novak+Test@Example.COM ' }).email).toBe(
        'mira.novak+test@example.com',
      );
    });

    it.each(['mira+news@example.com', 'mira@mail.example.photography', 'm.n@example.co'])(
      'accepts the valid address %j',
      (email) => {
        expect(RegisterBody.safeParse({ ...valid, email }).success).toBe(true);
      },
    );

    it.each(['', 'mira', 'mira@', '@example.com', 'mira novak@example.com', 'mira@example', 'mira@@example.com'])(
      'rejects %j with a readable message',
      (email) => {
        const result = RegisterBody.safeParse({ ...valid, email });
        expect(messages(result)).toContainEqual({ path: 'email', message: 'Please enter a valid email address.' });
      },
    );

    it('accepts 254 characters and rejects 255', () => {
      const domain = '@example.com';
      const at254 = `${'a'.repeat(254 - domain.length)}${domain}`;
      expect(RegisterBody.safeParse({ ...valid, email: at254 }).success).toBe(true);
      expect(RegisterBody.safeParse({ ...valid, email: `a${at254}` }).success).toBe(false);
    });
  });

  describe('password (F-09 as amended by ADR-0002: 12–256)', () => {
    it('rejects 11 characters with a readable message', () => {
      expect(messages(RegisterBody.safeParse({ ...valid, password: 'a'.repeat(11) }))).toEqual([
        { path: 'password', message: 'Use at least 12 characters.' },
      ]);
    });

    it('accepts 12 and 256 characters and rejects 257', () => {
      expect(RegisterBody.safeParse({ ...valid, password: 'a'.repeat(12) }).success).toBe(true);
      expect(RegisterBody.safeParse({ ...valid, password: 'a'.repeat(256) }).success).toBe(true);
      expect(RegisterBody.safeParse({ ...valid, password: 'a'.repeat(257) }).success).toBe(false);
    });

    it('never trims a password, so surrounding spaces count and are kept', () => {
      expect(RegisterBody.parse({ ...valid, password: '  ten chars ' }).password).toBe('  ten chars ');
    });

    it('has no composition rules', () => {
      expect(RegisterBody.safeParse({ ...valid, password: 'aaaaaaaaaaaa' }).success).toBe(true);
    });

    it('rejects a non-string password', () => {
      expect(RegisterBody.safeParse({ ...valid, password: 123456789012 }).success).toBe(false);
    });
  });
});

describe('LoginBody', () => {
  it('normalises the email like registration does', () => {
    expect(LoginBody.parse({ email: ' MIRA.NOVAK@example.com', password: 'x' })).toEqual({
      email: 'mira.novak@example.com',
      password: 'x',
    });
  });

  it('does not apply the new-password length policy to a login attempt', () => {
    expect(LoginBody.safeParse({ email: valid.email, password: 'short' }).success).toBe(true);
  });

  it('requires a password and caps its length', () => {
    expect(LoginBody.safeParse({ email: valid.email, password: '' }).success).toBe(false);
    expect(LoginBody.safeParse({ email: valid.email, password: 'a'.repeat(257) }).success).toBe(false);
  });
});

describe('AuthResponse and CsrfTokenResponse', () => {
  it('parse the documented shapes', () => {
    const user = { id: 1, firstName: 'Mira', lastName: 'Novak', avatarUrl: null, bio: null };
    expect(AuthResponse.parse({ user, csrfToken: 'token' })).toEqual({ user, csrfToken: 'token' });
    expect(CsrfTokenResponse.parse({ token: 'token' })).toEqual({ token: 'token' });
  });
});
