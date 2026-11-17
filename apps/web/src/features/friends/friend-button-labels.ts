import type { FriendshipState } from '@app/shared';

import { pluralize } from '../../shared/lib/format-count';

/*
 * The API answers with a friendship **state** (ADR-0003, B-53, F-45); every word the UI shows for it lives here.
 * Buttons are lowercase and start with a verb, messages are sentence case (maw-design-system §10, FEATURES "Label
 * casing"). Names are passed through as stored, never re-cased (F-58, B-110).
 */

/** What a person can do about a friendship. `cancel`, `decline` and `unfriend` all end it on the server. */
export type FriendAction = 'send' | 'cancel' | 'accept' | 'decline' | 'unfriend';

/** Where the actions are shown: under a profile's name, or at the end of a row on `/friends`. */
export type FriendActionPlace = 'profile' | 'row';

/**
 * The actions per state, in reading order; the first one is the primary action (F-45 table, F-49 decline).
 * A non-empty tuple, so every state has a primary action.
 */
export const ACTIONS_BY_STATE: Readonly<Record<FriendshipState, readonly [FriendAction, ...FriendAction[]]>> = {
  none: ['send'],
  pending_outgoing: ['cancel'],
  pending_incoming: ['accept', 'decline'],
  friends: ['unfriend'],
};

/** Visible labels on another user's profile (F-45): the profile heading already names the person. */
const PROFILE_LABELS: Readonly<Record<FriendAction, string>> = {
  send: 'add friend',
  cancel: 'cancel request',
  accept: 'accept request',
  decline: 'decline',
  unfriend: 'unfriend',
};

/** Visible labels in the lists on `/friends` (F-55), where the section heading gives the context. */
const ROW_LABELS: Readonly<Record<FriendAction, string>> = {
  send: 'add friend',
  cancel: 'cancel',
  accept: 'accept',
  decline: 'decline',
  unfriend: 'unfriend',
};

export interface FriendActionLabel {
  /** The visible, lowercase label. */
  text: string;
  /**
   * Added for assistive technology only, so ten "unfriend" buttons in a list are told apart (WCAG 2.4.6). It always
   * follows the visible label, so the accessible name starts with what is on screen (WCAG 2.5.3, label in name).
   */
  hiddenSuffix: string | null;
}

/** The label of `action` at `place`, e.g. `{ text: 'accept', hiddenSuffix: ' request from Sofia Lindqvist' }`. */
export function friendActionLabel(action: FriendAction, place: FriendActionPlace, userName: string): FriendActionLabel {
  if (place === 'profile') {
    return { text: PROFILE_LABELS[action], hiddenSuffix: null };
  }
  const suffix: Record<FriendAction, string> = {
    send: ` ${userName}`,
    cancel: ` request to ${userName}`,
    accept: ` request from ${userName}`,
    decline: ` request from ${userName}`,
    unfriend: ` ${userName}`,
  };
  return { text: ROW_LABELS[action], hiddenSuffix: suffix[action] };
}

/** The sentence announced (and shown on `/friends`) after the server confirmed `action`. */
export function friendActionDoneMessage(action: FriendAction, userName: string): string {
  switch (action) {
    case 'send':
      return `Friend request sent to ${userName}.`;
    case 'cancel':
      return `Friend request to ${userName} cancelled.`;
    case 'accept':
      return `You and ${userName} are now friends.`;
    case 'decline':
      return `Friend request from ${userName} declined.`;
    case 'unfriend':
      return `You and ${userName} are no longer friends.`;
  }
}

/** Copy of the unfriend confirmation (F-50). */
export function unfriendConfirmation(userName: string): { title: string; message: string; confirmLabel: string } {
  return {
    title: `Unfriend ${userName}?`,
    message: 'You will no longer see each other’s walls. You can send a new friend request later.',
    confirmLabel: 'unfriend',
  };
}

/** The meta line of a list entry, before its date (F-54): "friends since 15 Nov 2026". */
export const SINCE_PREFIX: Readonly<Record<Exclude<FriendshipState, 'none'>, string>> = {
  friends: 'friends since',
  pending_incoming: 'request received',
  pending_outgoing: 'request sent',
};

/** "1 friend request" / "2 friend requests", for the navigation badge (F-52). */
export function incomingRequestsLabel(count: number): string {
  return pluralize(count, 'friend request', 'friend requests');
}
