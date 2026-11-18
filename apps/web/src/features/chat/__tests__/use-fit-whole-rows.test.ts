import { describe, expect, it } from 'vitest';

import { fitWholeRows } from '../use-fit-whole-rows';

/** `fitWholeRows` for rows listed oldest first, as they appear in the log. */
function fit(capPx: number, chromePx: number, rowHeights: number[]): number | null {
  const total = rowHeights.reduce((sum, height) => sum + height, 0);
  return fitWholeRows(capPx, chromePx, total, rowHeights.toReversed());
}

describe('fitWholeRows (ADR-0015: no half-cut row at the top of the resting chat log)', () => {
  it('fits the newest rows that end within the cap and adds the container chrome', () => {
    // 356 px cap, 9 px border + padding: 347 px for rows. The newest four rows of 80 px (320 px) fit, five do not.
    expect(fit(356, 9, [80, 80, 80, 80, 80, 80])).toBe(329);
  });

  it('counts rows of different heights from the newest backwards', () => {
    // 200 px available: 60 + 100 = 160 fits, adding the 80 px row (240) does not; the oldest 20 px row is never reached.
    expect(fit(200, 0, [20, 80, 100, 60])).toBe(160);
  });

  it('keeps the natural height when every row fits', () => {
    expect(fit(400, 9, [80, 80, 80])).toBeNull();
  });

  it('keeps the cap when the newest row alone is taller than it', () => {
    expect(fit(240, 9, [80, 400])).toBeNull();
  });

  it('stops measuring at the first row that no longer fits', () => {
    const read: number[] = [];
    function* rows(): Generator<number> {
      for (const height of [100, 100, 100, 100]) {
        read.push(height);
        yield height;
      }
    }
    expect(fitWholeRows(250, 0, 400, rows())).toBe(200);
    expect(read).toHaveLength(3);
  });

  it('accepts a row that fits exactly despite fractional heights', () => {
    expect(fit(200.2, 0, [50, 100.5, 100.2])).toBeCloseTo(200.7);
  });
});
