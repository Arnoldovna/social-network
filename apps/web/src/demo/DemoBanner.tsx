import { DEMO_EMAIL } from '@app/shared/demo-seed';
import type { ReactNode } from 'react';

import { useConfirm } from '../shared/lib/use-confirm';
import { Button } from '../shared/ui/Button';
import { ConfirmDialog } from '../shared/ui/ConfirmDialog';
import { DEMO_PASSWORD } from './state';
import './DemoBanner.css';

/** German on purpose (PLAN.md Etappe 3b); marked `lang="de"` for screen readers. */
const NOTICE = 'Demo – Daten bleiben nur in deinem Browser';

/** The rose field with the German notice; `children` follow it on the same line. */
function DemoNotice({ children }: { children: ReactNode }) {
  return (
    <section className="demo-banner" aria-label="demo">
      <div className="demo-banner__inner">
        <p className="demo-banner__title" lang="de">
          {NOTICE}
        </p>
        {children}
      </div>
    </section>
  );
}

export interface DemoBannerProps {
  /** Deletes the browser's demo data and reloads the start page. */
  onReset: () => Promise<void>;
}

/**
 * The notice above the GitHub Pages demo (ADR-0020): that the data stays in this browser, the demo login, and "reset
 * demo data" behind a confirmation, because it deletes accounts, posts and pictures the visitor made. A flat rose field
 * with black text (maw-design-system §1, §4) and its own landmark. The dialog renders outside the field, so it keeps
 * the page's colours.
 */
export function DemoBanner({ onReset }: DemoBannerProps) {
  const confirm = useConfirm<true>(onReset);

  return (
    <>
      <DemoNotice>
        <p className="demo-banner__text">
          Log in as {DEMO_EMAIL} with the password {DEMO_PASSWORD}, or sign up. Nothing is sent to a server.
        </p>
        <Button
          className="demo-banner__reset"
          onClick={() => {
            confirm.request(true);
          }}
        >
          reset demo data
        </Button>
      </DemoNotice>
      <ConfirmDialog
        {...confirm.dialogProps}
        title="Reset the demo?"
        message="Everything you did here is deleted, and the demo starts again with its sample data."
        confirmLabel="reset demo data"
      />
    </>
  );
}

/** Shown when the demo cannot start: it needs service workers and IndexedDB. */
export function DemoUnavailable() {
  return (
    <DemoNotice>
      <p className="demo-banner__text">
        This demo needs service workers and IndexedDB, which this browser or window does not allow (for example a
        private window). Try a normal window, or run the project locally with pnpm demo.
      </p>
    </DemoNotice>
  );
}
