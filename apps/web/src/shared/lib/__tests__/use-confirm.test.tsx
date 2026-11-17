import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toApiError } from '../../api/problem';
import { PROBLEM_TYPE_PREFIX } from '@app/shared';
import { Button } from '../../ui/Button';
import { ConfirmDialog } from '../../ui/ConfirmDialog';
import { useConfirm } from '../use-confirm';

interface Post {
  id: number;
  excerpt: string;
}

const POSTS: Post[] = [
  { id: 41, excerpt: 'Back from the coast' },
  { id: 42, excerpt: 'Anyone up for the Saturday market?' },
];

/** Resolvable promise for actions whose outcome the test decides. */
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function PostList({
  onDelete,
  onConfirmed,
}: {
  onDelete: (post: Post) => Promise<unknown>;
  onConfirmed?: (post: Post) => void;
}) {
  const confirm = useConfirm(onDelete, onConfirmed === undefined ? {} : { onConfirmed });
  return (
    <>
      <ul>
        {POSTS.map((post) => (
          <li key={post.id}>
            {post.excerpt}
            <Button
              onClick={() => {
                confirm.request(post);
              }}
            >
              delete post {post.id}
            </Button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        {...confirm.dialogProps}
        title={`Delete “${confirm.target?.excerpt ?? ''}”?`}
        message="This cannot be undone."
        confirmLabel="delete post"
      />
    </>
  );
}

const forbidden = toApiError(403, {
  type: `${PROBLEM_TYPE_PREFIX}post-delete-forbidden`,
  title: 'Forbidden',
  status: 403,
});

describe('useConfirm', () => {
  afterEach(() => {
    cleanup();
  });

  it('is closed until a target is requested', () => {
    render(<PostList onDelete={vi.fn(() => Promise.resolve())} />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('opens for the requested target and runs the action for exactly that target', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(() => Promise.resolve());
    const onConfirmed = vi.fn();
    render(<PostList onDelete={onDelete} onConfirmed={onConfirmed} />);

    await user.click(screen.getByRole('button', { name: 'delete post 42' }));
    expect(screen.getByRole('alertdialog', { name: 'Delete “Anyone up for the Saturday market?”?' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'delete post' }));

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledWith(POSTS[1]);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onConfirmed).toHaveBeenCalledWith(POSTS[1]);
  });

  it('disables confirm while the action runs, so a double click sends one request (F-51)', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const onDelete = vi.fn(() => pending.promise);
    render(<PostList onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: 'delete post 41' }));
    const confirmButton = screen.getByRole('button', { name: 'delete post' });
    await user.click(confirmButton);

    expect(confirmButton).toBeDisabled();
    await user.click(confirmButton);
    expect(onDelete).toHaveBeenCalledTimes(1);

    pending.resolve();
    await vi.waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });

  it('keeps the dialog open with the error message when the action fails (F-53)', async () => {
    const user = userEvent.setup();
    // RTK Query's `unwrap()` rejects with the plain ApiError object, not an Error.
    const onDelete = vi.fn<(post: Post) => Promise<unknown>>().mockRejectedValue(forbidden);
    const onConfirmed = vi.fn();
    render(<PostList onDelete={onDelete} onConfirmed={onConfirmed} />);

    await user.click(screen.getByRole('button', { name: 'delete post 41' }));
    await user.click(screen.getByRole('button', { name: 'delete post' }));

    expect(await screen.findByText('Only the author or the wall owner can delete this post.')).toBeVisible();
    expect(screen.getByRole('alertdialog')).toBeVisible();
    expect(screen.getByRole('button', { name: 'delete post' })).toBeEnabled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('shows a generic sentence for an error that is not an API error', async () => {
    const user = userEvent.setup();
    render(<PostList onDelete={() => Promise.reject(new TypeError('x is undefined'))} />);

    await user.click(screen.getByRole('button', { name: 'delete post 41' }));
    await user.click(screen.getByRole('button', { name: 'delete post' }));

    expect(await screen.findByText('Something went wrong on our side. Please try again.')).toBeVisible();
    expect(screen.queryByText('x is undefined')).not.toBeInTheDocument();
  });

  it('clears the previous error when confirming again, and closes on success', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn().mockRejectedValueOnce(forbidden).mockResolvedValueOnce(undefined);
    render(<PostList onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: 'delete post 41' }));
    await user.click(screen.getByRole('button', { name: 'delete post' }));
    await screen.findByText('Only the author or the wall owner can delete this post.');

    await user.click(screen.getByRole('button', { name: 'delete post' }));
    await vi.waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it('cancel closes without running the action', async () => {
    const user = userEvent.setup();
    const onDelete = vi.fn(() => Promise.resolve());
    render(<PostList onDelete={onDelete} />);

    await user.click(screen.getByRole('button', { name: 'delete post 41' }));
    await user.click(screen.getByRole('button', { name: 'cancel' }));

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('ignores the outcome of an action whose dialog was closed meanwhile', async () => {
    const user = userEvent.setup();
    const first = deferred();
    const onDelete = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(undefined);
    const onConfirmed = vi.fn();
    render(<PostList onDelete={onDelete} onConfirmed={onConfirmed} />);

    await user.click(screen.getByRole('button', { name: 'delete post 41' }));
    await user.click(screen.getByRole('button', { name: 'delete post' }));
    await user.click(screen.getByRole('button', { name: 'cancel' }));

    // A new confirmation for another post is open when the first action finally fails.
    await user.click(screen.getByRole('button', { name: 'delete post 42' }));
    first.reject(forbidden);
    await Promise.resolve();

    expect(screen.getByRole('alertdialog', { name: 'Delete “Anyone up for the Saturday market?”?' })).toBeVisible();
    expect(screen.queryByText('Only the author or the wall owner can delete this post.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'delete post' })).toBeEnabled();
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});
