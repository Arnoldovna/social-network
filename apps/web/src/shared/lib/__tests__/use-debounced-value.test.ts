import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DEBOUNCE_MS, useDebouncedValue } from '../use-debounced-value';

describe('useDebouncedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the initial value immediately', () => {
    const { result } = renderHook(() => useDebouncedValue('mi'));
    expect(result.current).toBe('mi');
  });

  it('waits 300 ms after the last change by default (F-59)', () => {
    expect(DEFAULT_DEBOUNCE_MS).toBe(300);
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value), {
      initialProps: { value: '' },
    });

    rerender({ value: 'm' });
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(result.current).toBe('');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe('m');
  });

  it('restarts the timer on every change, so a burst yields only the last value', () => {
    const seen: string[] = [];
    const { rerender } = renderHook(
      ({ value }) => {
        const debounced = useDebouncedValue(value, 300);
        if (seen.at(-1) !== debounced) {
          seen.push(debounced);
        }
        return debounced;
      },
      { initialProps: { value: '' } },
    );

    for (const value of ['m', 'mi', 'mir', 'mira']) {
      rerender({ value });
      act(() => {
        vi.advanceTimersByTime(200);
      });
    }
    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(seen).toEqual(['', 'mira']);
  });

  it('honours a custom delay', () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 50), {
      initialProps: { value: 1 },
    });
    rerender({ value: 2 });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toBe(2);
  });

  it('cancels the pending update on unmount', () => {
    const { rerender, unmount } = renderHook(({ value }) => useDebouncedValue(value), {
      initialProps: { value: 'a' },
    });
    rerender({ value: 'b' });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
