import { FriendshipState } from '@app/shared';
import { describe, expect, it } from 'vitest';

import { deriveFriendshipState, type FriendshipRowState } from '../friendship-state.js';

const MIRA = 1;
const JONAS = 2;
const OUTSIDER = 3;

const pending: FriendshipRowState = { status: 'pending', requesterId: MIRA, addresseeId: JONAS };
const accepted: FriendshipRowState = { status: 'accepted', requesterId: MIRA, addresseeId: JONAS };

describe('deriveFriendshipState (DATA-MODEL derivation table, F-45)', () => {
  it('is none without a row', () => {
    expect(deriveFriendshipState(undefined, MIRA)).toBe('none');
    expect(deriveFriendshipState(null, MIRA)).toBe('none');
  });

  it('is pending_outgoing for the requester and pending_incoming for the addressee of a pending row', () => {
    expect(deriveFriendshipState(pending, MIRA)).toBe('pending_outgoing');
    expect(deriveFriendshipState(pending, JONAS)).toBe('pending_incoming');
  });

  it('is friends for both sides of an accepted row, whoever asked first', () => {
    expect(deriveFriendshipState(accepted, MIRA)).toBe('friends');
    expect(deriveFriendshipState(accepted, JONAS)).toBe('friends');
    expect(deriveFriendshipState({ ...accepted, requesterId: JONAS, addresseeId: MIRA }, MIRA)).toBe('friends');
  });

  it('B-52: reads requesterId/addresseeId, so swapping them swaps the pending direction', () => {
    const reversed: FriendshipRowState = { status: 'pending', requesterId: JONAS, addresseeId: MIRA };

    expect(deriveFriendshipState(reversed, MIRA)).toBe('pending_incoming');
    expect(deriveFriendshipState(reversed, JONAS)).toBe('pending_outgoing');
  });

  it('B-52: throws for a row the viewer is not part of instead of matching by accident', () => {
    expect(() => deriveFriendshipState(pending, OUTSIDER)).toThrow(RangeError);
    expect(() => deriveFriendshipState(accepted, OUTSIDER)).toThrow(RangeError);
  });

  it('throws for a self-row, which the schema forbids (friendships_not_self_chk)', () => {
    expect(() => deriveFriendshipState({ status: 'pending', requesterId: MIRA, addresseeId: MIRA }, MIRA)).toThrow(
      RangeError,
    );
  });

  it('B-53: returns only states of the shared enum, never UI labels', () => {
    const rows: (FriendshipRowState | undefined)[] = [undefined, pending, accepted];
    const states = rows.flatMap((row) => [deriveFriendshipState(row, MIRA), deriveFriendshipState(row, JONAS)]);

    for (const state of states) expect(FriendshipState.safeParse(state).success).toBe(true);
    expect(new Set(states)).toEqual(new Set(FriendshipState.options));
  });
});
