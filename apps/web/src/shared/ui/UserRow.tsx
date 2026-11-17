import type { UserSummary } from '@app/shared';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { fullName } from '../lib/names';
import { Avatar } from './Avatar';
import './UserRow.css';

export interface UserRowProps {
  user: UserSummary;
  /** Small tracked meta next to the name, e.g. "request sent 15 Nov 2026" or a RelativeTime. */
  meta?: ReactNode;
  /** Buttons for this person (accept, decline, unfriend); they sit at the end of the row. */
  actions?: ReactNode;
  /** `li` inside a `<ul>` (friends, online users), `div` elsewhere. */
  as?: 'li' | 'div';
}

/**
 * One person as a maw list row (ADR-0015): avatar and name left, meta and actions right, a 1px rule below that turns
 * ink while the row is hovered or holds focus. The name links to the profile (F-54, F-86); the avatar stays outside
 * the link so the link's name is just the person's name, while the picture keeps its alt text (F-101).
 */
export function UserRow({ user, meta, actions, as: Element = 'li' }: UserRowProps) {
  const name = fullName(user);
  const hasMeta = meta !== undefined && meta !== null && meta !== '';

  return (
    <Element className="user-row">
      <div className="user-row__body">
        <Avatar firstName={user.firstName} lastName={user.lastName} src={user.avatarUrl} />
        <div className="user-row__text">
          <Link className="user-row__name" to={`/users/${String(user.id)}`}>
            {name}
          </Link>
          {hasMeta ? <p className="user-row__meta">{meta}</p> : null}
        </div>
        {actions === undefined || actions === null ? null : <div className="user-row__actions">{actions}</div>}
      </div>
    </Element>
  );
}
