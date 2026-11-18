import { Link } from 'react-router';

import './SiteFooter.css';

/** The source of this project on GitHub (private until the repository is made public). */
const REPOSITORY_URL = 'https://github.com/Arnoldovna/social-network';

/** The year the project was published; a copyright notice names it, not the current year. */
const COPYRIGHT_YEAR = 2026;

export interface SiteFooterProps {
  /** The about page of the area the footer is in: `/welcome/about` for visitors, `/about` for members. */
  aboutPath: string;
}

/**
 * The page footer of both layouts (maw-design-system §6 "Footer", ADR-0015): an ink-muted rule on top, lowercase meta
 * links (about, the source on GitHub) and the copyright year at the end. The external link opens in the same tab,
 * like every other link of the app.
 */
export function SiteFooter({ aboutPath }: SiteFooterProps) {
  return (
    <footer className="site-footer">
      <ul className="site-footer__links">
        <li className="site-footer__item">
          <Link className="site-footer__link" to={aboutPath}>
            about
          </Link>
        </li>
        <li className="site-footer__item">
          <a className="site-footer__link" href={REPOSITORY_URL}>
            github
          </a>
        </li>
      </ul>
      <p className="site-footer__copyright">© {COPYRIGHT_YEAR}</p>
    </footer>
  );
}
