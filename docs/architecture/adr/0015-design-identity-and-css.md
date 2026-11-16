# ADR-0015: maw identity with the rose accent, Tailwind 4 in CSS files only

- Status: accepted (revised after the architecture critique: header layout, no inline theme script, single owner of utility classes)
- Date: 2026-11-15
- Related: B-102–B-131, F-11, F-58, F-94, F-98–F-104; skills `maw-design-system`, `modular-css-tailwind4`

## Context

The legacy stylesheet uses hard-coded colours (B-113), fixed/absolute positioning with magic numbers (B-114), no
responsive rules (B-115), ID and structural selectors (B-116, B-117), invalid values (B-119), 8–11 px text
(B-121), no focus styles (B-106, B-123) and a universal Arial selector (B-124). PLAN.md fixes the maw-studio identity
and the Tailwind 4 rules.

## Decision

- Tokens: `maw-design-system/templates/tokens.css` copied verbatim to `apps/web/src/styles/tokens.css`, only
  `--color-accent: var(--color-rose)` (`#E59797`). `@theme static`, every default namespace reset.
- Font: Schibsted Grotesk via **`@fontsource/schibsted-grotesk` 5.3.0, weights 400 and 500 only**
  (`import '@fontsource/schibsted-grotesk/400.css'` and `500.css` in `main.tsx`), the package the scaffold template
  ships, because the design system mandates the static two-weight setup. Licence copied to
  `LICENSES/OFL-SchibstedGrotesk.txt`. No commercial typeface is referenced anywhere.
- CSS: `@import "tailwindcss" source(none)`; one CSS file per React component, named after it, one BEM block,
  `@reference "#styles/main.css"`, `@layer components`, logical properties, container queries for components,
  `motion-safe` for all motion, global `:focus-visible` (2px ink, offset 4px). No utility classes in markup
  (`scripts/check-no-utilities.mjs`), stylelint config from the skill.
- Rose (`#E59797`) is < 3:1 on paper: it appears only as **flat fields** with black text (`on-accent`), e.g. the
  brand panel on the welcome page, the friend-request badge field, the primary button (at most once per view), the
  default avatar field. Current page and selection are always also marked in ink (2px underline, `aria-current`).
- Patterns used: site header (wordmark "let's chat", lowercase nav "profile / friends / online / chat", search,
  avatar button, "log out"); list rows for friends, search results, online users and chat messages (name left,
  meta right, 1px rules); wall posts as rows; `<dialog>` for the avatar upload and confirmations; empty states as a
  left-aligned sentence + one text button; "loading…" text and surface blocks without shimmer.
- Avatars: square, no radius, `aspect-ratio: 1`, `object-fit: cover`, fixed size tokens; the default avatar is the
  user's initials in ink on a rose field (no random-face service, no generic silhouette).
- **Header layout.** The header holds the wordmark, four nav links, the search, the avatar button, the friend
  badge and "log out" – about 1,050 px in one row with links at `text-title`. It therefore never uses one row:
  - ≥ 640 px: **two rows**. Row 1: wordmark left; search, avatar button and "log out" right. Row 2: the nav links
    ("profile / friends / online / chat" + badge) at `text-lead`, separated from the content by a 1px rule. Row 1
    needs about 520 px at 640 px width, row 2 about 400 px. The header stays sticky with `--header-fade`.
  - < 640 px: wordmark, avatar button and a "menu" disclosure button (`aria-expanded`, `aria-controls`; allowed by
    maw because there are more than three links, F-94) that reveals nav links, search and "log out".
  - Acceptance: `layout.spec` asserts no horizontal overflow and no overlapping header elements at 320, 390, 640,
    768, 1024, 1280 and 1440 px; the design review screenshots include 768 and 1024.
  This deviates from the maw single-row header (1–3 links) only in the second row, which the review rubric's
  "header wraps cleanly" criterion allows.
- Names render as stored; any uppercase styling is CSS `text-transform` (F-58, B-110), though the maw identity uses
  none.
- Dark mode via token redefinition only (`prefers-color-scheme`), no `dark:` variants. **No theme bootstrap
  script** in `index.html`: FEATURES defines no theme toggle, tokens.css already follows `prefers-color-scheme`,
  and an inline script would violate the nginx CSP (`script-src 'self'`). If a toggle is added later, it loads
  `/theme-init.js` from `public/` in `<head>`. E2E fixtures fail any test that logs a CSP violation.
- `.visually-hidden` and `.skip-link` have one owner: `styles/utilities.css` (skill template). The `SkipLink` and
  `VisuallyHidden` components use those classes and have no CSS file of their own.

## Alternatives

- **Component library (MUI, Radix Themes)**: conflicts with the maw identity and the "no utility classes, tokens only"
  rule.
- **CSS Modules everywhere**: allowed by the skill only where hashed names are needed; global BEM is enough.
- **Variable font package**: one file, but the design system limits weights to 400/500 and specifies the static
  package.

## Consequences

- The CSS & Design phase runs the design review rubric (screenshots at 390, 768, 1440, dark 1440, hover and focus)
  and the anti-AI checklist; ≥ 24/30 to pass.
- Frontend module phases already create one CSS file per component with structural rules, because the utility
  checker requires every class in markup to be defined.
