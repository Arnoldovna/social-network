import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Button } from '../Button';

afterEach(cleanup);

describe('Button', () => {
  it('renders a native button that never submits by default', () => {
    render(<Button>add friend</Button>);

    const button = screen.getByRole('button', { name: 'add friend' });
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveClass('button', { exact: true });
  });

  it('submits a form only when asked to', () => {
    render(<Button type="submit">save</Button>);

    expect(screen.getByRole('button', { name: 'save' })).toHaveAttribute('type', 'submit');
  });

  it.each([
    ['outlined', 'button button--outlined'],
    ['accent', 'button button--outlined button--accent'],
  ] as const)('adds the BEM modifiers of the %s variant', (variant, classes) => {
    render(<Button variant={variant}>log in</Button>);

    expect(screen.getByRole('button', { name: 'log in' })).toHaveAttribute('class', classes);
  });

  it("mixes in the parent block's element class", () => {
    render(<Button className="bio-editor__cancel">cancel</Button>);

    expect(screen.getByRole('button', { name: 'cancel' })).toHaveAttribute('class', 'button bio-editor__cancel');
  });

  it('calls onClick and forwards the ref', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Button ref={ref} onClick={onClick}>
        accept
      </Button>,
    );

    await user.click(screen.getByRole('button', { name: 'accept' }));

    expect(onClick).toHaveBeenCalledOnce();
    expect(ref.current).toBe(screen.getByRole('button', { name: 'accept' }));
  });

  it('does not react while disabled (F-51)', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        accept
      </Button>,
    );

    await user.click(screen.getByRole('button', { name: 'accept' }));

    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'accept' })).toBeDisabled();
  });
});
