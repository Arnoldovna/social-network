import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { SkipLink } from '../SkipLink';

afterEach(cleanup);

describe('SkipLink', () => {
  it('is the first Tab stop and points at the main landmark (F-103)', async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipLink />
        <a href="/">let's chat</a>
        <main id="main">content</main>
      </>,
    );

    await user.tab();

    const link = screen.getByRole('link', { name: 'skip to content' });
    expect(link).toHaveFocus();
    expect(link).toHaveAttribute('href', '#main');
    expect(link).toHaveClass('skip-link');
  });

  it('moves focus into main without adding a Tab stop', async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipLink />
        <main id="main">content</main>
      </>,
    );

    await user.click(screen.getByRole('link', { name: 'skip to content' }));

    const main = screen.getByRole('main');
    expect(main).toHaveFocus();
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  it('keeps a tabindex the target already has', async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipLink targetId="content" label="skip to chat" />
        <main id="content" tabIndex={-1}>
          content
        </main>
      </>,
    );

    await user.click(screen.getByRole('link', { name: 'skip to chat' }));

    expect(screen.getByRole('main')).toHaveFocus();
    expect(screen.getByRole('main')).toHaveAttribute('tabindex', '-1');
  });

  it('leaves the default link behaviour alone when the target is missing', async () => {
    const user = userEvent.setup();
    render(<SkipLink targetId="nowhere" />);

    await user.click(screen.getByRole('link', { name: 'skip to content' }));

    expect(screen.getByRole('link', { name: 'skip to content' })).toHaveAttribute('href', '#nowhere');
  });
});
