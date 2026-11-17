import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TextArea } from '../TextArea';

afterEach(cleanup);

describe('TextArea', () => {
  it('labels the textarea with a visible label (F-75)', () => {
    render(<TextArea label="Write on Ada's wall" name="body" />);

    const textarea = screen.getByRole('textbox', { name: "Write on Ada's wall" });
    expect(textarea.tagName).toBe('TEXTAREA');
    expect(textarea).toHaveAttribute('rows', '4');
    expect(textarea).not.toHaveAttribute('aria-describedby');
  });

  it.each([
    [12, 1000, '988 characters left'],
    [0, 1000, '1,000 characters left'],
    [999, 1000, '1 character left'],
    [1000, 1000, '0 characters left'],
    [1001, 1000, '1 character too many'],
    [1012, 1000, '12 characters too many'],
  ])('shows the live counter for %i of %i characters (F-29)', (length, max, text) => {
    render(<TextArea label="bio" characterCount={{ length, max }} />);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.getByLabelText('bio')).toHaveAccessibleDescription(text);
  });

  it('marks the counter over the limit with a modifier, not only by colour', () => {
    render(<TextArea label="bio" characterCount={{ length: 1012, max: 1000 }} />);

    expect(screen.getByText('12 characters too many')).toHaveClass('text-area__count', 'text-area__count--over');
  });

  it('describes the field by error, hint and counter in that order', () => {
    render(
      <TextArea
        label="bio"
        hint="Plain text, line breaks are kept."
        error="Keep your bio under 1,000 characters."
        characterCount={{ length: 1001, max: 1000 }}
      />,
    );

    const textarea = screen.getByLabelText('bio');
    expect(textarea).toHaveAttribute('aria-invalid', 'true');
    expect(textarea).toHaveAccessibleDescription(
      'Keep your bio under 1,000 characters. Plain text, line breaks are kept. 1 character too many',
    );
  });

  it('passes ref and key handlers through (Ctrl/Cmd+Enter, F-75)', async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLTextAreaElement>();
    const onKeyDown = vi.fn();
    render(<TextArea label="message" ref={ref} onKeyDown={onKeyDown} rows={2} />);

    await user.type(screen.getByLabelText('message'), 'hi{Control>}{Enter}{/Control}');

    expect(ref.current).toBe(screen.getByLabelText('message'));
    expect(ref.current).toHaveAttribute('rows', '2');
    expect(onKeyDown).toHaveBeenCalledWith(expect.objectContaining({ key: 'Enter', ctrlKey: true }));
  });
});
