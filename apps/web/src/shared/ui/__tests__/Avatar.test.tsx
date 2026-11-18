import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Avatar } from '../Avatar';

afterEach(cleanup);

const AVATAR_URL = '/api/users/12/avatar?v=0f5b8c1e-4c1d-4f7e-9a39-3c3b5b0f2d11';
const NEW_AVATAR_URL = '/api/users/12/avatar?v=7d2e9a40-1b6f-4b8c-8f0e-52a1c9d3e6b7';

describe('Avatar', () => {
  it('F-101, B-102: shows the picture with "<name>\'s profile picture" as alt text', () => {
    render(<Avatar firstName="Ada" lastName="Brennan" src={AVATAR_URL} />);

    const image = screen.getByRole('img', { name: "Ada Brennan's profile picture" });
    expect(image.tagName).toBe('IMG');
    expect(image).toHaveAttribute('src', AVATAR_URL);
    expect(image).toHaveClass('avatar__image');
  });

  it('shows the initials on the rose field without a picture (ADR-0015)', () => {
    render(<Avatar firstName="Ada" lastName="Brennan" src={null} />);

    const initials = screen.getByRole('img', { name: "Ada Brennan's profile picture" });
    expect(initials.tagName).toBe('SPAN');
    expect(initials).toHaveTextContent('AB');
    expect(initials).toHaveClass('avatar__initials');
  });

  it('falls back to the initials when the image fails to load (ADR-0010)', () => {
    render(<Avatar firstName="Ada" lastName="Brennan" src={AVATAR_URL} />);

    fireEvent.error(screen.getByRole('img', { name: "Ada Brennan's profile picture" }));

    expect(screen.getByRole('img', { name: "Ada Brennan's profile picture" })).toHaveTextContent('AB');
    expect(document.querySelector('img')).toBeNull();
  });

  it('tries a new avatar URL again after a failed one (F-37)', () => {
    const { rerender } = render(<Avatar firstName="Ada" lastName="Brennan" src={AVATAR_URL} />);
    fireEvent.error(screen.getByRole('img'));

    rerender(<Avatar firstName="Ada" lastName="Brennan" src={NEW_AVATAR_URL} />);

    expect(screen.getByRole('img', { name: "Ada Brennan's profile picture" })).toHaveAttribute('src', NEW_AVATAR_URL);
  });

  it.each([
    ['ada', 'brennan', 'AB'],
    ['Émile', 'Ølstad', 'ÉØ'],
    ['  Noor ', ' Haddad', 'NH'],
    ['Zoë', '', 'Z'],
    ['', '', '?'],
  ])('derives the initials of %j %j as %j', (firstName, lastName, initials) => {
    render(<Avatar firstName={firstName} lastName={lastName} src={null} />);

    expect(screen.getByRole('img')).toHaveTextContent(initials);
  });

  it('keeps a first character made of several code points whole', () => {
    // "e" plus a combining acute accent is one grapheme; splitting it would show a stray accent.
    render(<Avatar firstName={'éva'} lastName="Lund" src={null} />);

    expect(screen.getByRole('img')).toHaveTextContent('ÉL');
  });

  it('builds the alt text with the shared name helpers, so a blank or padded part leaves no stray space', () => {
    render(<Avatar firstName=" Ada " lastName="  " src={AVATAR_URL} />);

    expect(document.querySelector('img')).toHaveAttribute('alt', "Ada's profile picture");
  });

  it('renders names as stored, uppercase only in the initials (F-58)', () => {
    render(<Avatar firstName="ada" lastName="de la Cruz" src={null} />);

    expect(screen.getByRole('img', { name: "ada de la Cruz's profile picture" })).toHaveTextContent('AD');
  });

  it('is hidden from assistive technology when decorative', () => {
    const { rerender } = render(<Avatar firstName="Ada" lastName="Brennan" src={AVATAR_URL} decorative />);
    expect(document.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    rerender(<Avatar firstName="Ada" lastName="Brennan" src={null} decorative />);
    expect(screen.getByText('AB')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it.each([
    [undefined, 'avatar avatar--small'],
    ['medium', 'avatar avatar--medium'],
    ['large', 'avatar avatar--large'],
  ] as const)('uses the fixed size modifier for size %s', (size, classes) => {
    const { container } = render(<Avatar firstName="Ada" lastName="Brennan" src={null} size={size} />);

    expect(container.firstElementChild).toHaveAttribute('class', classes);
  });

  it("mixes in the parent's element class", () => {
    const { container } = render(
      <Avatar firstName="Ada" lastName="Brennan" src={null} size="large" className="profile-header__avatar" />,
    );

    expect(container.firstElementChild).toHaveAttribute('class', 'avatar avatar--large profile-header__avatar');
  });
});
