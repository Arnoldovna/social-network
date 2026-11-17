import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { FieldError } from '../FieldError';

afterEach(cleanup);

describe('FieldError', () => {
  it.each([undefined, ''])('renders nothing without a message (%j)', (message) => {
    const { container } = render(<FieldError id="email-error">{message}</FieldError>);

    expect(container).toBeEmptyDOMElement();
  });

  it('announces the message as an alert with the given id', () => {
    render(<FieldError id="email-error">Please enter a valid email address.</FieldError>);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Please enter a valid email address.');
    expect(alert).toHaveAttribute('id', 'email-error');
    expect(alert).toHaveClass('field-error');
  });
});
