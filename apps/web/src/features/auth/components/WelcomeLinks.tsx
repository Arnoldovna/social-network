import { Link } from 'react-router';

import './WelcomeLinks.css';

export interface WelcomeLink {
  /** Plain text before the link ("Not a member yet?"); omitted for a bare link. */
  lead?: string;
  to: string;
  label: string;
}

/**
 * The links at the end of every welcome page (F-96): to the other welcome pages, as a list above a 1px rule. Plain
 * text links, never buttons, because they navigate.
 */
export function WelcomeLinks({ links }: { links: readonly WelcomeLink[] }) {
  return (
    <ul className="welcome-links">
      {links.map(({ lead, to, label }) => (
        <li key={to} className="welcome-links__item">
          {lead === undefined ? null : `${lead} `}
          <Link className="welcome-links__link" to={to}>
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
