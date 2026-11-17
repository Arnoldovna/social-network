import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Dialog } from '../Dialog';
import type { DialogProps } from '../Dialog';

afterEach(cleanup);

function getDialogElement(): HTMLDialogElement {
  const dialog = document.querySelector('dialog');
  if (dialog === null) {
    throw new Error('no <dialog> rendered');
  }
  return dialog;
}

/** A trigger that owns the open state, like the avatar button does (F-33, F-34). */
function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Change profile picture
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="profile picture"
        initialFocusRef={saveRef}
      >
        <button ref={saveRef} type="button">
          save
        </button>
      </Dialog>
    </>
  );
}

function renderDialog(props: Partial<DialogProps> = {}) {
  const onClose = vi.fn();
  const utils = render(
    <Dialog open onClose={onClose} title="profile picture" {...props}>
      <p>Choose a JPEG, PNG, WebP or GIF image.</p>
    </Dialog>,
  );
  return { ...utils, onClose };
}

describe('Dialog', () => {
  it('renders nothing inside a closed dialog', () => {
    renderDialog({ open: false });

    expect(getDialogElement().open).toBe(false);
    expect(screen.queryByText('Choose a JPEG, PNG, WebP or GIF image.')).not.toBeInTheDocument();
  });

  it('opens as a modal labelled by its title', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    renderDialog();

    expect(showModal).toHaveBeenCalledOnce();
    expect(getDialogElement().open).toBe(true);
    expect(screen.getByRole('dialog', { name: 'profile picture' })).toBe(getDialogElement());
    expect(screen.getByRole('heading', { level: 2, name: 'profile picture' })).toBeInTheDocument();
    expect(screen.getByText('Choose a JPEG, PNG, WebP or GIF image.')).toBeInTheDocument();
  });

  it('closes with the "close" button', async () => {
    const user = userEvent.setup();
    const { onClose } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'close' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reports a native close (Escape) exactly once', () => {
    const { onClose } = renderDialog();

    // The browser closes the dialog itself on Escape and fires `close`; happy-dom has no Escape handling.
    act(() => {
      getDialogElement().close();
    });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('asks the caller on Escape instead of closing behind its back', () => {
    const { onClose } = renderDialog();
    const cancel = new Event('cancel', { cancelable: true });

    act(() => {
      getDialogElement().dispatchEvent(cancel);
    });

    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    // The caller here keeps `open`, so the dialog stays open with its content.
    expect(getDialogElement().open).toBe(true);
    expect(screen.getByText('Choose a JPEG, PNG, WebP or GIF image.')).toBeInTheDocument();
  });

  it('leaves an uncancelable Escape to the close event, so it is reported once', () => {
    const { onClose } = renderDialog();

    act(() => {
      getDialogElement().dispatchEvent(new Event('cancel', { cancelable: false }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      getDialogElement().close();
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows itself again when the browser closed it but the caller keeps it open', () => {
    const { onClose } = renderDialog();

    act(() => {
      getDialogElement().close();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(getDialogElement().open).toBe(true);
    expect(screen.getByRole('dialog', { name: 'profile picture' })).toBeInTheDocument();
  });

  it('keeps Escape to itself: ancestors never see it, and nothing prevents the cancel that follows (F-34)', async () => {
    const user = userEvent.setup();
    const keysSeenOutside: string[] = [];
    const { container } = render(
      <div
        onKeyDown={(event) => {
          keysSeenOutside.push(event.key);
          // Like the header menu: an ancestor that closes itself on Escape and claims the key.
          event.preventDefault();
        }}
      >
        <Dialog open onClose={vi.fn()} title="profile picture">
          <button type="button">save</button>
        </Dialog>
      </div>,
    );
    const escapeDefaults: boolean[] = [];
    // Added after React's own listener on the root, so it sees the event once every handler ran.
    container.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') escapeDefaults.push(event.defaultPrevented);
    });
    screen.getByRole('button', { name: 'save' }).focus();

    await user.keyboard('{Escape}{ArrowDown}');

    expect(keysSeenOutside).toEqual(['ArrowDown']);
    expect(escapeDefaults).toEqual([false]);
  });

  it('closes on a click on the backdrop', () => {
    const { onClose } = renderDialog();
    const dialog = getDialogElement();

    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stays open for clicks inside and for a selection dragged out to the backdrop', () => {
    const { onClose } = renderDialog();
    const text = screen.getByText('Choose a JPEG, PNG, WebP or GIF image.');

    fireEvent.pointerDown(text);
    fireEvent.click(text);
    fireEvent.pointerDown(text);
    fireEvent.click(getDialogElement());

    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes when the prop turns false without reporting it back', () => {
    const { onClose, rerender } = renderDialog();

    rerender(
      <Dialog open={false} onClose={onClose} title="profile picture">
        <p>Choose a JPEG, PNG, WebP or GIF image.</p>
      </Dialog>,
    );

    expect(getDialogElement().open).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('focuses the initial focus target and returns focus to the trigger on close (F-34)', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'Change profile picture' });

    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'save' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'close' }));
    expect(getDialogElement().open).toBe(false);
    expect(trigger).toHaveFocus();
  });

  it('returns focus to the trigger after a native close as well', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole('button', { name: 'Change profile picture' });

    await user.click(trigger);
    act(() => {
      getDialogElement().close();
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });

  it('closes and restores focus when it unmounts while open', () => {
    const trigger = document.createElement('button');
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = renderDialog();

    const dialog = getDialogElement();
    unmount();

    expect(dialog.open).toBe(false);
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  it('supports the alertdialog role, a description and a mixed-in class', () => {
    render(
      <Dialog
        open
        onClose={vi.fn()}
        title="Unfriend Ada Brennan?"
        role="alertdialog"
        describedBy="why"
        className="confirm-dialog"
      >
        <p id="why">You can send a new friend request later.</p>
      </Dialog>,
    );

    const dialog = screen.getByRole('alertdialog', { name: 'Unfriend Ada Brennan?' });
    expect(dialog).toHaveAccessibleDescription('You can send a new friend request later.');
    expect(dialog).toHaveAttribute('class', 'dialog confirm-dialog');
  });
});
