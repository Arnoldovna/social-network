import { useId } from 'react';

import { WelcomeLinks } from '../components/WelcomeLinks';
import './AboutPage.css';

interface Technology {
  name: string;
  role: string;
}

/**
 * The stack, as plain text (F-97, B-112): no dead `href="#"` links, and no external links that could rot. The order
 * follows a request from the browser to the database.
 */
const TECHNOLOGIES: readonly Technology[] = [
  { name: 'React 19', role: 'the interface, one page app with real paths' },
  { name: 'React Router', role: 'routing and the guards that keep visitors and members apart' },
  { name: 'Redux Toolkit and RTK Query', role: 'server data, cached and updated by live events' },
  { name: 'React Hook Form and Zod', role: 'forms checked by the same rules as the server' },
  { name: 'Socket.IO', role: 'chat, wall posts, friend requests and presence in real time' },
  { name: 'Express 5 and TypeScript', role: 'the API, one module per feature' },
  { name: 'PostgreSQL and Drizzle ORM', role: 'users, friendships, wall posts and chat messages' },
  { name: 'Redis', role: 'sessions, rate limits and who is online' },
  { name: 'MinIO', role: 'S3-compatible storage for profile pictures' },
  { name: 'Tailwind CSS 4', role: 'design tokens behind plain BEM class names' },
  { name: 'Vitest, Testing Library and Playwright', role: 'unit, component, API and end-to-end tests' },
  { name: 'Docker and GitHub Actions', role: 'production images, tested end to end on every pull request' },
];

export interface AboutPageProps {
  /**
   * `visitor` (default): `/welcome/about`, ending with the links to sign up and log in (F-96). `member`: `/about`, the
   * footer's "about" inside the app area, without those links (a member is already signed in).
   */
  audience?: 'visitor' | 'member';
}

/**
 * What the project is and what it is built with (F-97): `/welcome/about` for visitors, `/about` for members.
 */
export function AboutPage({ audience = 'visitor' }: AboutPageProps) {
  const stackHeadingId = useId();

  return (
    <div className="about-page">
      <title>About · Let's chat!</title>
      <h1 className="about-page__title">About</h1>
      <div className="about-page__text">
        <p className="about-page__paragraph">
          Let's chat! is a small social network. You write a short bio, add a profile picture, send friend requests,
          write on your friends' walls, talk in one shared chat room and see who is online.
        </p>
        <p className="about-page__paragraph">
          It started in 2018 as a bootcamp project and was rebuilt in 2026: typed from the database to the browser,
          tested at every layer, usable by keyboard and screen reader, and with the security problems of the first
          version fixed.
        </p>
      </div>
      <section className="about-page__section" aria-labelledby={stackHeadingId}>
        <h2 id={stackHeadingId} className="about-page__section-title">
          built with
        </h2>
        <dl className="about-page__stack">
          {TECHNOLOGIES.map((technology) => (
            <div key={technology.name} className="about-page__stack-row">
              <dt className="about-page__stack-name">{technology.name}</dt>
              <dd className="about-page__stack-role">{technology.role}</dd>
            </div>
          ))}
        </dl>
      </section>
      {audience === 'visitor' ? (
        <WelcomeLinks
          links={[
            { lead: 'Not a member yet?', to: '/welcome', label: 'sign up' },
            { lead: 'Already a member?', to: '/welcome/login', label: 'log in' },
          ]}
        />
      ) : null}
    </div>
  );
}
