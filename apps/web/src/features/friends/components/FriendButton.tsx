import type { FriendshipChange, FriendshipState } from '@app/shared';
import { useLayoutEffect, useRef, useState } from 'react';

import { errorMessage, isApiError } from '../../../shared/api/problem';
import { hasLostFocus } from '../../../shared/lib/focus';
import { tokenList } from '../../../shared/lib/token-list';
import { useConfirm } from '../../../shared/lib/use-confirm';
import { Button } from '../../../shared/ui/Button';
import { ConfirmDialog } from '../../../shared/ui/ConfirmDialog';
import { FieldError } from '../../../shared/ui/FieldError';
import { VisuallyHidden } from '../../../shared/ui/VisuallyHidden';
import {
  ACTIONS_BY_STATE,
  friendActionDoneMessage,
  friendActionLabel,
  unfriendConfirmation,
} from '../friend-button-labels';
import type { FriendAction, FriendActionPlace } from '../friend-button-labels';
import {
  useAcceptFriendRequestMutation,
  useRemoveFriendshipMutation,
  useSendFriendRequestMutation,
} from '../friends.api';
import './FriendButton.css';

/** What a confirmed action reports to its container. */
export interface FriendActionResult {
  action: FriendAction;
  /** The state the server answered with, from the viewer's point of view. */
  state: FriendshipState;
  /** The sentence that says what happened ("You and Sofia Lindqvist are now friends."). */
  message: string;
}

export interface FriendActionsProps {
  userId: number;
  /** The person's name as stored (F-58), for hidden labels, the confirmation and the announcement. */
  userName: string;
  /** The last state the server reported (profile `relationship.state` or the list the entry is in). */
  state: FriendshipState;
  place: FriendActionPlace;
  /** Called once the server confirmed an action. */
  onDone?: (result: FriendActionResult) => void;
  /**
   * Called with the message when an action failed. Without it the message is shown inline under the buttons. The
   * unfriend confirmation always shows its own failure inside the dialog (F-53).
   */
  onError?: (message: string) => void;
}

/**
 * The friendship actions for one person (F-45 table): the buttons for the current state, the unfriend confirmation
 * (F-50) and the request handling.
 *
 * - Every action waits for the server: the label changes to the state the server answered with, never before (B-26).
 *   That answer is shown until the `state` prop changes, i.e. until the refetch the mutation triggers arrives.
 * - While a request runs every button is disabled and the running one is `aria-busy`; a second click in the same
 *   moment is ignored, so a double click sends one request (F-51, B-95).
 * - A failure shows the mapped problem message and the buttons stay as they were (F-53); a 404/409 means the
 *   friendship changed elsewhere, and the refetch shows the real state (B-26). It also drops this component's last
 *   answer, which is now outdated: otherwise a refetch that brings the same state the prop already had (a request
 *   declined before the profile was refetched) would leave the outdated buttons on screen for good.
 * - The primary button is the same element in every state, so keyboard focus stays on it when its label changes; if
 *   the focused button disappears (decline), focus moves to it.
 */
export function FriendActions({ userId, userName, state, place, onDone, onError }: FriendActionsProps) {
  const [sendRequest] = useSendFriendRequestMutation();
  const [acceptRequest] = useAcceptFriendRequestMutation();
  const [removeFriendship] = useRemoveFriendshipMutation();

  // The server's answer to this component's last action, until the parent passes a newer state (see above).
  const [confirmedState, setConfirmedState] = useState<FriendshipState | null>(null);
  const [stateFromProps, setStateFromProps] = useState(state);
  if (stateFromProps !== state) {
    setStateFromProps(state);
    setConfirmedState(null);
  }
  const shownState = confirmedState ?? state;

  const [running, setRunning] = useState<FriendAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const inFlight = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);

  const mutate = (action: FriendAction): Promise<FriendshipChange> => {
    const target = { userId };
    switch (action) {
      case 'send':
        return sendRequest(target).unwrap();
      case 'accept':
        return acceptRequest(target).unwrap();
      case 'cancel':
      case 'decline':
      case 'unfriend':
        return removeFriendship(target).unwrap();
    }
  };

  const finish = (action: FriendAction, change: FriendshipChange) => {
    const message = friendActionDoneMessage(action, userName);
    restoreFocus.current = true;
    setConfirmedState(change.state);
    if (place === 'profile') {
      setAnnouncement(message);
    }
    onDone?.({ action, state: change.state, message });
  };

  /** After a 404/409 the server state is whatever the parent reports next (see above), not this component's answer. */
  const forgetOutdatedAnswer = (failure: unknown) => {
    if (isApiError(failure) && (failure.status === 404 || failure.status === 409)) {
      setConfirmedState(null);
    }
  };

  const unfriend = useConfirm<FriendAction>(async (action) => {
    let change: FriendshipChange;
    try {
      change = await mutate(action);
    } catch (failure: unknown) {
      forgetOutdatedAnswer(failure);
      throw failure;
    }
    finish(action, change);
  });

  const run = (action: FriendAction) => {
    if (action === 'unfriend') {
      setError(null);
      unfriend.request(action);
      return;
    }
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setRunning(action);
    setError(null);
    mutate(action).then(
      (change) => {
        inFlight.current = false;
        setRunning(null);
        finish(action, change);
      },
      (failure: unknown) => {
        inFlight.current = false;
        setRunning(null);
        forgetOutdatedAnswer(failure);
        const message = errorMessage(failure);
        if (onError === undefined) {
          setError(message);
        } else {
          onError(message);
        }
      },
    );
  };

  // After a confirmed change the button that was used may be gone (decline): focus the primary button instead of
  // leaving it on the document. Runs before paint, so focus never visibly jumps.
  useLayoutEffect(() => {
    if (!restoreFocus.current) {
      return;
    }
    restoreFocus.current = false;
    if (hasLostFocus() && rootRef.current?.isConnected === true) {
      primaryRef.current?.focus();
    }
  }, [shownState]);

  const confirmation = unfriendConfirmation(userName);
  const busy = running !== null;

  return (
    <div ref={rootRef} className={tokenList('friend-button', place === 'row' && 'friend-button--row')}>
      <div className="friend-button__actions">
        {ACTIONS_BY_STATE[shownState].map((action, index) => {
          const label = friendActionLabel(action, place, userName);
          const isPrimary = index === 0;
          return (
            <Button
              // Stable keys by position: the primary button survives a state change, and so does its focus.
              key={isPrimary ? 'primary' : `secondary-${String(index)}`}
              ref={isPrimary ? primaryRef : undefined}
              variant={place === 'profile' && isPrimary ? 'outlined' : 'text'}
              disabled={busy}
              aria-busy={running === action ? true : undefined}
              onClick={() => {
                run(action);
              }}
            >
              {label.text}
              {label.hiddenSuffix === null ? null : <VisuallyHidden>{label.hiddenSuffix}</VisuallyHidden>}
            </Button>
          );
        })}
      </div>
      <FieldError>{error}</FieldError>
      {place === 'profile' ? <VisuallyHidden role="status">{announcement}</VisuallyHidden> : null}
      <ConfirmDialog
        {...unfriend.dialogProps}
        title={confirmation.title}
        message={confirmation.message}
        confirmLabel={confirmation.confirmLabel}
      />
    </div>
  );
}

export interface FriendButtonProps {
  userId: number;
  userName: string;
  state: FriendshipState;
}

/**
 * The friendship action on another user's profile (F-45): "add friend", "cancel request", "accept request" +
 * "decline", or "unfriend" with a confirmation. The profile passes `relationship.state` from `GET /api/users/:id`;
 * every action refetches that profile, so the prop follows the server.
 */
export function FriendButton({ userId, userName, state }: FriendButtonProps) {
  return <FriendActions userId={userId} userName={userName} state={state} place="profile" />;
}
