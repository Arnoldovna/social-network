import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '../../shared/test/render';
import { MainNav } from '../header/MainNav';
import { SiteHeader } from '../header/SiteHeader';

// Rule 7: the header composes four features; their stand-ins keep this test independent of the Phase 3 units.
vi.mock('../../features/friends', async () => (await import('./fakes')).friendsFeature);
vi.mock('../../features/search', async () => (await import('./fakes')).searchFeature);
vi.mock('../../features/avatars', async () => (await import('./fakes')).avatarsFeature);
vi.mock('../../features/auth', async () => (await import('./fakes')).authFeature);

const LINKS = [
  ['profile', '/'],
  ['friends', '/friends'],
  ['online', '/online'],
  ['chat', '/chat'],
] as const;

function renderNav(path: string) {
  return renderWithProviders(<MainNav />, { initialEntries: [path] });
}

describe('MainNav (F-92, F-93)', () => {
  it('F-92: is the "Main" navigation with profile, friends, online and chat in this order', () => {
    renderNav('/');

    const nav = screen.getByRole('navigation', { name: 'Main' });
    const links = within(nav).getAllByRole('link');
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual(LINKS);
  });

  it.each(LINKS)('F-93: marks "%s" as the current page on %s, and only that link', (label, path) => {
    renderNav(path);

    const nav = screen.getByRole('navigation', { name: 'Main' });
    for (const link of within(nav).getAllByRole('link')) {
      if (link.textContent === label) {
        expect(link).toHaveAttribute('aria-current', 'page');
      } else {
        expect(link).not.toHaveAttribute('aria-current');
      }
    }
  });

  it('F-93: marks no link on another user’s profile ("profile" is the own profile only)', () => {
    renderNav('/users/7');

    for (const link of screen.getAllByRole('link')) {
      expect(link).not.toHaveAttribute('aria-current');
    }
  });

  it('F-52: shows the friend-request badge inside the friends item', () => {
    renderNav('/');

    const friendsItem = screen.getByRole('link', { name: 'friends' }).closest('li');
    expect(friendsItem).not.toBeNull();
    expect(within(friendsItem!).getByText('2 new requests')).toBeInTheDocument();
  });

  it('F-03: navigates inside the router without a document load (B-79)', async () => {
    const { user, router } = renderNav('/');

    await user.click(screen.getByRole('link', { name: 'chat' }));

    expect(router.state.location.pathname).toBe('/chat');
    expect(screen.getByRole('link', { name: 'chat' })).toHaveAttribute('aria-current', 'page');
  });

  it('F-93: marks the current page by aria-current only, links keep their one BEM class (no router "active" class)', () => {
    renderNav('/friends');

    for (const link of screen.getAllByRole('link')) {
      expect(link).toHaveAttribute('class', 'main-nav__link');
    }
  });
});

describe('SiteHeader (F-92, F-94, B-109)', () => {
  function renderHeader(path = '/') {
    const rendered = renderWithProviders(<SiteHeader />, { initialEntries: [path] });
    const menuButton = screen.getByRole('button', { name: 'menu' });
    const panelId = menuButton.getAttribute('aria-controls') ?? '';
    const panel = () => document.getElementById(panelId);
    return { ...rendered, menuButton, panel };
  }

  it('F-92: is the banner with the wordmark linking to /, search, navigation, avatar button and log out', () => {
    renderHeader('/friends');

    const banner = screen.getByRole('banner');
    expect(within(banner).getByRole('link', { name: "let's chat" })).toHaveAttribute('href', '/');
    expect(within(banner).getByRole('searchbox', { name: 'find people' })).toBeInTheDocument();
    expect(within(banner).getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'change profile picture' })).toHaveAttribute(
      'data-variant',
      'header',
    );
    expect(within(banner).getByRole('button', { name: 'log out' })).toBeInTheDocument();
  });

  it('F-94, B-109: has a "menu" disclosure button that controls the panel with search, log out and navigation', () => {
    const { menuButton, panel } = renderHeader();

    // A native button (the legacy "MENU" was a styled `<p>` that did nothing), which never submits a form.
    expect(menuButton.tagName).toBe('BUTTON');
    expect(menuButton).toHaveAttribute('type', 'button');
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).not.toBeNull();
    const content = within(panel()!);
    expect(content.getByRole('searchbox', { name: 'find people' })).toBeInTheDocument();
    expect(content.getByRole('button', { name: 'log out' })).toBeInTheDocument();
    expect(content.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    // The avatar button stays in the bar, outside the panel.
    expect(content.queryByRole('button', { name: 'change profile picture' })).not.toBeInTheDocument();
  });

  it('F-94, B-109: opens and closes the panel with the button', async () => {
    const { user, menuButton, panel } = renderHeader();
    expect(panel()).toHaveClass('site-header__panel');
    expect(panel()).not.toHaveClass('site-header__panel--open');

    await user.click(menuButton);
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    expect(panel()).toHaveClass('site-header__panel--open');

    await user.click(menuButton);
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(panel()).not.toHaveClass('site-header__panel--open');
  });

  it('F-94: closes on Escape and returns focus to the menu button', async () => {
    const { user, menuButton } = renderHeader();
    await user.click(menuButton);
    await user.click(screen.getByRole('searchbox', { name: 'find people' }));

    await user.keyboard('{Escape}');

    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
    expect(menuButton).toHaveFocus();
  });

  it('F-94: leaves an Escape that a control inside already handled to that control', async () => {
    const { user, menuButton } = renderHeader();
    await user.click(menuButton);
    const searchbox = screen.getByRole('searchbox', { name: 'find people' });
    searchbox.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') event.preventDefault();
    });
    await user.click(searchbox);

    await user.keyboard('{Escape}');

    expect(menuButton).toHaveAttribute('aria-expanded', 'true');
    expect(searchbox).toHaveFocus();
  });

  it('F-94: closes after a navigation, including to the page that is already open', async () => {
    const { user, menuButton, router } = renderHeader('/chat');

    await user.click(menuButton);
    await user.click(screen.getByRole('link', { name: 'friends' }));
    expect(router.state.location.pathname).toBe('/friends');
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(menuButton);
    await user.click(screen.getByRole('link', { name: 'friends' }));
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('F-94: keeps the focus order equal to the visual order: bar first, then the panel', async () => {
    // happy-dom applies no stylesheet, so the panel is reachable while "closed"; this checks the DOM order only, which
    // is the visual order of both layouts (SiteHeader.css).
    const { user, menuButton } = renderHeader();
    const expected = [
      screen.getByRole('link', { name: "let's chat" }),
      screen.getByRole('button', { name: 'change profile picture' }),
      menuButton,
      screen.getByRole('searchbox', { name: 'find people' }),
      screen.getByRole('button', { name: 'log out' }),
      screen.getByRole('link', { name: 'profile' }),
    ];

    for (const element of expected) {
      await user.tab();
      expect(element).toHaveFocus();
    }
  });
});
