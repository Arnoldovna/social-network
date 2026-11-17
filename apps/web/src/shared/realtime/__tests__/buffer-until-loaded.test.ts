import { describe, expect, it } from 'vitest';

import { bufferUntilLoaded } from '../buffer-until-loaded';

describe('bufferUntilLoaded (B-86)', () => {
  it('keeps events until the first response is in the cache, then replays them in order', () => {
    const applied: number[] = [];
    const events = bufferUntilLoaded<number>((event) => applied.push(event));

    events.push(1);
    events.push(2);
    expect(applied).toEqual([]);

    events.flush();
    expect(applied).toEqual([1, 2]);
  });

  it('applies every event after the flush at once', () => {
    const applied: number[] = [];
    const events = bufferUntilLoaded<number>((event) => applied.push(event));
    events.flush();

    events.push(3);

    expect(applied).toEqual([3]);
  });
});
