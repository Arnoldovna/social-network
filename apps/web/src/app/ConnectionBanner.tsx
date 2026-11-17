import { selectRealtimeStatus } from '../shared/realtime/realtimeSlice';
import { useAppSelector } from './hooks';
import './ConnectionBanner.css';

/**
 * "Reconnecting…" while the socket is down (F-107): a non-blocking bar at the top of the page, nothing is covered or
 * disabled. socket.io-client (or the 30 s handshake retry) brings the connection back, and the realtime listener then
 * refetches what the socket would have delivered.
 *
 * The `role="status"` region is always mounted and only its content changes, so screen readers announce the message
 * when it appears (a live region added together with its text is often not read). It is empty while connected, idle
 * (visitors, logged out) or connecting for the first time.
 */
export function ConnectionBanner() {
  const status = useAppSelector(selectRealtimeStatus);

  return (
    <div className="connection-banner" role="status">
      {status === 'reconnecting' ? (
        <div className="connection-banner__bar">
          <p className="connection-banner__message">
            <span className="connection-banner__title">Reconnecting…</span>{' '}
            <span>Live updates continue once the connection is back.</span>
          </p>
        </div>
      ) : null}
    </div>
  );
}
