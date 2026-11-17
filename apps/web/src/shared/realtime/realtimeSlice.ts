import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction } from '@reduxjs/toolkit';

import { sessionExpired } from '../session/session-events';

/**
 * `idle`: no socket (visitor, logged out, session expired). `connecting`: first handshake after sign-in.
 * `connected`: live. `reconnecting`: the socket is down while the user is signed in: the connection dropped, the
 * first handshake failed, or the server asked to wait; socket.io-client (or our 30 s retry) brings it back, and the
 * app shows "Reconnecting…" meanwhile (F-107), because live updates are missing either way.
 */
export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting';

export interface RealtimeState {
  status: RealtimeStatus;
}

const initialState: RealtimeState = { status: 'idle' };

/**
 * The only plain slice for client state (ADR-0012): the socket's connection status and nothing else. Server data that
 * arrives over the socket goes into the RTK Query cache of the endpoint that owns it.
 */
export const realtimeSlice = createSlice({
  name: 'realtime',
  initialState,
  reducers: {
    connecting(state) {
      state.status = 'connecting';
    },
    /** `resumed` is `true` when this connect ends a `reconnecting` phase, i.e. events may have been missed. */
    connected(state, _action: PayloadAction<{ resumed: boolean }>) {
      state.status = 'connected';
    },
    reconnecting(state) {
      state.status = 'reconnecting';
    },
    disconnected(state) {
      state.status = 'idle';
    },
  },
  extraReducers: (builder) => {
    // The banner must not say "Reconnecting…" on the way to the login page.
    builder.addCase(sessionExpired, (state) => {
      state.status = 'idle';
    });
  },
  selectors: {
    selectRealtimeStatus: (state) => state.status,
  },
});

export const realtimeActions = realtimeSlice.actions;
export const { selectRealtimeStatus } = realtimeSlice.selectors;
