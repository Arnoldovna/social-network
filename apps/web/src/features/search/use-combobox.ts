import { useEffect, useState } from 'react';
import type { KeyboardEvent } from 'react';

export interface UseComboboxOptions<T> {
  /** Unique prefix for the listbox and option ids, usually the component's `useId()`. */
  id: string;
  /** The options currently shown in the listbox, in display order; empty when no listbox is shown. */
  items: readonly T[];
  /** A stable key per item, unique within `items` and valid inside an id (e.g. the user id as a string). */
  getKey: (item: T) => string;
  /**
   * The list belongs to the scope it was opened in. Passing the router's `location.key` closes it on every
   * navigation (a chosen result, back/forward) during render, without an effect.
   */
  scope: string;
  /** Enter on the active option. The list closes afterwards. */
  onSelect: (item: T) => void;
}

/** Props for the `<input>` that owns the listbox (WAI-ARIA combobox with list autocomplete). */
export interface ComboboxInputProps {
  role: 'combobox';
  'aria-autocomplete': 'list';
  'aria-controls': string;
  'aria-expanded': boolean;
  'aria-activedescendant': string | undefined;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
}

export interface ComboboxOptionProps {
  id: string;
  role: 'option';
  'aria-selected': boolean;
}

export interface Combobox<T> {
  /** The list was opened in the current scope and not closed since. */
  isOpen: boolean;
  /** Opens the list with no active option (typing, submitting). */
  open: () => void;
  /** Closes the list and forgets the active option. */
  close: () => void;
  /** The option arrow keys moved to, if it is still among `items`. */
  activeItem: T | undefined;
  listboxId: string;
  inputProps: ComboboxInputProps;
  getOptionProps: (item: T) => ComboboxOptionProps;
}

/**
 * Keyboard and ARIA state of an editable combobox whose popup is a listbox (WAI-ARIA APG "Combobox", list
 * autocomplete without automatic selection; F-62, B-94). Focus stays in the input; the active option is announced
 * through `aria-activedescendant` and marked with `aria-selected`.
 *
 * - ArrowDown / ArrowUp: open the list on the first / last option, or move through it, wrapping at both ends.
 *   Alt+ArrowDown only opens it.
 * - Enter: chooses the active option. Without one, Enter is left to the surrounding form (an immediate search).
 * - Escape: closes an open list and prevents the default, so a surrounding disclosure (the header menu) only closes
 *   on the next Escape. With the list closed, Escape is not handled here.
 *
 * Closing on outside clicks and on focus leaving the widget belongs to the component, which owns the DOM.
 */
export function useCombobox<T>({ id, items, getKey, scope, onSelect }: UseComboboxOptions<T>): Combobox<T> {
  const [openedIn, setOpenedIn] = useState<string | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const isOpen = openedIn === scope;
  const listboxId = `${id}-listbox`;
  const optionId = (item: T) => `${id}-option-${getKey(item)}`;
  // Derived, not stored: when the results change, a key that is no longer listed simply means "no active option".
  const activeIndex = isOpen && activeKey !== null ? items.findIndex((item) => getKey(item) === activeKey) : -1;
  const activeItem = activeIndex === -1 ? undefined : items[activeIndex];
  const activeOptionId = activeItem === undefined ? undefined : optionId(activeItem);

  // Keep the active option visible when the listbox scrolls (up to 20 results).
  useEffect(() => {
    if (activeOptionId !== undefined) {
      document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeOptionId]);

  const open = () => {
    setOpenedIn(scope);
    setActiveKey(null);
  };

  const close = () => {
    setOpenedIn(null);
    setActiveKey(null);
  };

  const activate = (index: number) => {
    const item = items[index];
    setActiveKey(item === undefined ? null : getKey(item));
  };

  const moveActive = (direction: 1 | -1) => {
    if (!isOpen) {
      setOpenedIn(scope);
      activate(direction === 1 ? 0 : items.length - 1);
      return;
    }
    if (items.length === 0) {
      return;
    }
    const start = activeIndex === -1 ? (direction === 1 ? -1 : items.length) : activeIndex;
    activate((start + direction + items.length) % items.length);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (event.altKey) {
          if (!isOpen) {
            open();
          }
          return;
        }
        moveActive(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        return;
      case 'Enter':
        if (activeItem !== undefined) {
          event.preventDefault();
          onSelect(activeItem);
          close();
        }
        return;
      case 'Escape':
        if (isOpen) {
          event.preventDefault();
          close();
        }
        return;
      default:
        return;
    }
  };

  return {
    isOpen,
    open,
    close,
    activeItem,
    listboxId,
    inputProps: {
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-controls': listboxId,
      'aria-expanded': isOpen && items.length > 0,
      'aria-activedescendant': activeOptionId,
      onKeyDown,
    },
    getOptionProps: (item) => ({
      id: optionId(item),
      role: 'option',
      'aria-selected': activeItem !== undefined && getKey(item) === getKey(activeItem),
    }),
  };
}
