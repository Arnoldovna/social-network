import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TextField } from '../TextField';

afterEach(cleanup);

describe('TextField', () => {
  it('labels the input with a visible label', () => {
    render(<TextField label="email" name="email" type="email" />);

    const input = screen.getByLabelText('email');
    expect(input).toHaveAttribute('type', 'email');
    expect(input).toHaveAttribute('name', 'email');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('defaults to a text input', () => {
    render(<TextField label="first name" />);

    expect(screen.getByRole('textbox', { name: 'first name' })).toHaveAttribute('type', 'text');
  });

  it('links the hint with aria-describedby', () => {
    render(<TextField label="password" type="password" hint="At least 12 characters." />);

    expect(screen.getByLabelText('password')).toHaveAccessibleDescription('At least 12 characters.');
  });

  it('marks the input invalid and reads the error before the hint', () => {
    render(
      <TextField label="password" type="password" hint="At least 12 characters." error="Use at least 12 characters." />,
    );

    const input = screen.getByLabelText('password');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Use at least 12 characters. At least 12 characters.');
    expect(screen.getByRole('alert')).toHaveTextContent('Use at least 12 characters.');
  });

  it('keeps an aria-describedby the caller links itself', () => {
    render(
      <>
        <p id="terms">We never show your email address.</p>
        <TextField label="email" aria-describedby="terms" error="Please enter a valid email address." />
      </>,
    );

    expect(screen.getByLabelText('email')).toHaveAccessibleDescription(
      'Please enter a valid email address. We never show your email address.',
    );
  });

  it('uses the given id for the label association', () => {
    render(<TextField id="login-email" label="email" />);

    expect(screen.getByLabelText('email')).toHaveAttribute('id', 'login-email');
  });

  it("passes ref and handlers through, as react-hook-form's register() needs", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLInputElement>();
    const onChange = vi.fn();
    const onBlur = vi.fn();
    render(<TextField label="last name" name="lastName" ref={ref} onChange={onChange} onBlur={onBlur} />);

    await user.type(screen.getByLabelText('last name'), 'Brennan');
    await user.tab();

    expect(ref.current).toBe(screen.getByLabelText('last name'));
    expect(ref.current?.value).toBe('Brennan');
    expect(onChange).toHaveBeenCalledTimes('Brennan'.length);
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it("mixes the parent's element class into the wrapper", () => {
    const { container } = render(<TextField label="email" className="auth-form__field" />);

    expect(container.firstElementChild).toHaveAttribute('class', 'text-field auth-form__field');
  });
});
