import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearCsrfToken, ensureCsrfToken, getCsrfToken, setCsrfToken } from '../csrf';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('csrf token store', () => {
  afterEach(() => {
    clearCsrfToken();
  });

  it('starts empty', () => {
    expect(getCsrfToken()).toBeNull();
  });

  it('loads the token once and keeps it in memory', async () => {
    const load = vi.fn(() => Promise.resolve('token-a'));

    await expect(ensureCsrfToken(load)).resolves.toBe('token-a');
    await expect(ensureCsrfToken(load)).resolves.toBe('token-a');

    expect(load).toHaveBeenCalledTimes(1);
    expect(getCsrfToken()).toBe('token-a');
  });

  it('shares one request between concurrent callers', async () => {
    const response = deferred<string>();
    const load = vi.fn(() => response.promise);

    const callers = [ensureCsrfToken(load), ensureCsrfToken(load), ensureCsrfToken(load)];
    response.resolve('token-a');

    await expect(Promise.all(callers)).resolves.toEqual(['token-a', 'token-a', 'token-a']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('uses the token from login/register without loading one', async () => {
    const load = vi.fn(() => Promise.resolve('unused'));
    setCsrfToken('from-login');

    await expect(ensureCsrfToken(load)).resolves.toBe('from-login');
    expect(load).not.toHaveBeenCalled();
  });

  it('forgets the token on clear (logout, session expiry), so the next call loads a new one', async () => {
    setCsrfToken('old-session');
    clearCsrfToken();
    expect(getCsrfToken()).toBeNull();

    const load = vi.fn(() => Promise.resolve('new-session'));
    await expect(ensureCsrfToken(load)).resolves.toBe('new-session');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rejects every waiting caller when loading fails, keeps no token and tries again next time', async () => {
    const failure = new Error('offline');
    const load = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce('token-b');

    const first = ensureCsrfToken(load);
    const second = ensureCsrfToken(load);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(getCsrfToken()).toBeNull();

    await expect(ensureCsrfToken(load)).resolves.toBe('token-b');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never hands out the token of a load that started before a logout, but loads one for the new session', async () => {
    const oldSession = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(oldSession.promise).mockResolvedValueOnce('token-of-the-new-session');
    const waiting = [ensureCsrfToken(load), ensureCsrfToken(load)];

    clearCsrfToken();
    oldSession.resolve('token-of-the-old-session');

    // Every caller that waited gets the new session's token, from one more request (not one each).
    await expect(Promise.all(waiting)).resolves.toEqual(['token-of-the-new-session', 'token-of-the-new-session']);
    expect(getCsrfToken()).toBe('token-of-the-new-session');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('joins a load that started after the logout instead of starting another one', async () => {
    const oldSession = deferred<string>();
    const newSession = deferred<string>();
    const load = vi.fn().mockReturnValueOnce(oldSession.promise).mockReturnValueOnce(newSession.promise);
    const beforeLogout = ensureCsrfToken(load);

    clearCsrfToken();
    const afterLogout = ensureCsrfToken(load);
    oldSession.resolve('token-of-the-old-session');
    newSession.resolve('token-of-the-new-session');

    await expect(beforeLogout).resolves.toBe('token-of-the-new-session');
    await expect(afterLogout).resolves.toBe('token-of-the-new-session');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('prefers the login token over a load that was still running', async () => {
    const response = deferred<string>();
    const pending = ensureCsrfToken(() => response.promise);

    setCsrfToken('from-login');
    response.resolve('anonymous-session-token');

    await expect(pending).resolves.toBe('from-login');
    expect(getCsrfToken()).toBe('from-login');
  });
});
