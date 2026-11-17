import type { ReactNode } from 'react';

import { fullName } from '../../../shared/lib/names';
import './ProfileHeader.css';

export interface ProfileHeaderProps {
  firstName: string;
  lastName: string;
  /** The large picture: the own `AvatarButton` (F-33) or another user's `Avatar` (F-40). */
  avatar: ReactNode;
  /** The bio area: the own `BioEditor` or another user's bio text (F-24, F-40). */
  children: ReactNode;
  /** Actions about this person, e.g. the friend button (F-45). Omitted on the own profile. */
  actions?: ReactNode;
}

/**
 * The top of a profile page (F-24, F-40): picture left, then the full name as the page's only `<h1>` (B-108), the bio
 * and the actions. Names render as stored (F-58).
 */
export function ProfileHeader({ firstName, lastName, avatar, children, actions }: ProfileHeaderProps) {
  return (
    <header className="profile-header">
      <div className="profile-header__layout">
        <div className="profile-header__avatar">{avatar}</div>
        <div className="profile-header__body">
          <h1 className="profile-header__name">{fullName({ firstName, lastName })}</h1>
          <div className="profile-header__bio">{children}</div>
          {actions === undefined ? null : <div className="profile-header__actions">{actions}</div>}
        </div>
      </div>
    </header>
  );
}
