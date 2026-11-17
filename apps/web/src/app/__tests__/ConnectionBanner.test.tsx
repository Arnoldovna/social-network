import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { realtimeActions } from '../../shared/realtime/realtimeSlice';
import { sessionExpired } from '../../shared/session/session-events';
import { renderWithProviders } from '../../shared/test/render';
import { ConnectionBanner } from '../ConnectionBanner';
import { createAppStore } from '../store';

function renderBanner() {
  const store = createAppStore();
  renderWithProviders(<ConnectionBanner />, { store });
  const region = screen.getByRole('status');
  return { store, region };
}

describe('ConnectionBanner (F-107)', () => {
  it('keeps an empty live region mounted while there is nothing to report', () => {
    const { store, region } = renderBanner();
    expect(region).toBeEmptyDOMElement();

    act(() => {
      store.dispatch(realtimeActions.connecting());
    });
    expect(region).toBeEmptyDOMElement();

    act(() => {
      store.dispatch(realtimeActions.connected({ resumed: false }));
    });
    expect(region).toBeEmptyDOMElement();
  });

  it('says "Reconnecting…" inside the same region while the socket is down, and clears it once it is back', () => {
    const { store, region } = renderBanner();

    act(() => {
      store.dispatch(realtimeActions.reconnecting());
    });
    expect(region).toHaveTextContent('Reconnecting… Live updates continue once the connection is back.');
    expect(screen.getByRole('status')).toBe(region);

    act(() => {
      store.dispatch(realtimeActions.connected({ resumed: true }));
    });
    expect(region).toBeEmptyDOMElement();
  });

  it('disappears on the way to the login page when the session expired', () => {
    const { store, region } = renderBanner();
    act(() => {
      store.dispatch(realtimeActions.reconnecting());
    });

    act(() => {
      store.dispatch(sessionExpired());
    });

    expect(region).toBeEmptyDOMElement();
  });
});
