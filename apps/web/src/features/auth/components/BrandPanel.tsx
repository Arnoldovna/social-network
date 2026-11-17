import './BrandPanel.css';

interface BrandPanelRow {
  term: string;
  detail: string;
}

/** What the app does, one row per area, in the order of the main navigation. */
const ROWS: readonly BrandPanelRow[] = [
  { term: 'profile', detail: 'A short bio and a profile picture.' },
  { term: 'friends', detail: 'Requests you send, accept or cancel.' },
  { term: 'walls', detail: "Posts on your own wall and on your friends' walls." },
  { term: 'chat', detail: 'One room for everyone, updated live.' },
  { term: 'online', detail: 'Who is around right now.' },
];

/**
 * The rose brand panel of the welcome area (F-95, ADR-0015): a flat accent field with black text (never white or muted
 * text on an accent, maw-design-system §4) beside the forms from 1024 px and above them on small screens. It sits in
 * the welcome banner before the page's `<h1>`, so it has no heading of its own; the rows are a description list.
 */
export function BrandPanel() {
  return (
    <div className="brand-panel">
      <p className="brand-panel__lead">A small social network for profiles, friends, walls and one shared chat room.</p>
      <dl className="brand-panel__list">
        {ROWS.map((row) => (
          <div key={row.term} className="brand-panel__row">
            <dt className="brand-panel__term">{row.term}</dt>
            <dd className="brand-panel__detail">{row.detail}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
