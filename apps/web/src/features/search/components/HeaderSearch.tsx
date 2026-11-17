import { SEARCH_LIMIT_DEFAULT, SEARCH_QUERY_MAX } from '@app/shared';
import type { UserSummary } from '@app/shared';
import { skipToken } from '@reduxjs/toolkit/query/react';
import { useEffect, useEffectEvent, useId, useRef, useState } from 'react';
import type { ChangeEvent, FocusEvent, MouseEvent, SubmitEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

import { errorMessage } from '../../../shared/api/problem';
import { pluralize } from '../../../shared/lib/format-count';
import { fullName } from '../../../shared/lib/names';
import { profilePath } from '../../../shared/lib/paths';
import { tokenList } from '../../../shared/lib/token-list';
import { useDebouncedValue } from '../../../shared/lib/use-debounced-value';
import { Avatar } from '../../../shared/ui/Avatar';
import { Button } from '../../../shared/ui/Button';
import { useSearchUsersQuery } from '../search.api';
import { useCombobox } from '../use-combobox';
import './HeaderSearch.css';

/** What the popup shows for the current input. */
type SearchPhase = 'idle' | 'loading' | 'error' | 'results' | 'empty';

/**
 * The popup's content for the current input. `found` is the answer for the query in flight (`currentData`, never an
 * earlier query's), so a new query shows "searching…" until its own answer arrives.
 */
function searchView({
  trimmed,
  found,
  failed,
}: {
  trimmed: string;
  found: readonly UserSummary[] | undefined;
  failed: boolean;
}): { phase: SearchPhase; results: readonly UserSummary[] } {
  if (trimmed === '') {
    return { phase: 'idle', results: [] };
  }
  if (found !== undefined) {
    return found.length > 0 ? { phase: 'results', results: found } : { phase: 'empty', results: [] };
  }
  return { phase: failed ? 'error' : 'loading', results: [] };
}

function userKey(user: UserSummary): string {
  return String(user.id);
}

/** "1 person found." / "3 people found." for the live region; the list itself is the visible answer. */
function countSentence(count: number): string {
  return `${pluralize(count, 'person', 'people')} found.`;
}

/**
 * "find people" in the header (F-59, F-62, F-63; B-49, B-93, B-94): an editable WAI-ARIA combobox whose listbox holds
 * the matching people.
 *
 * - Typing searches 300 ms after the last keystroke; Enter searches at once (implicit submit of the search form).
 *   The query is trimmed and at most 100 characters, as `SearchQuery` requires.
 * - Arrow keys move through the results while focus stays in the input; Enter on a result, or a click, opens
 *   `/users/:id`. Every result is a real link (B-93), so it can also be opened in a new tab.
 * - Escape closes the list (and only the list: the header menu closes on the next Escape). Clicking outside or moving
 *   focus out of the search closes it too (B-94). Any navigation closes it, because it belongs to the location key.
 * - No match is a sentence, never an empty or crashing list (F-63, B-49); loading and errors are shown in the same
 *   place, with "try again" for errors (F-105). One polite live region announces each state, including the count.
 */
export function HeaderSearch() {
  const id = useId();
  const inputId = `${id}-input`;
  const labelId = `${id}-label`;
  const formRef = useRef<HTMLFormElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  const [term, setTerm] = useState('');
  // The query Enter asked for; it only applies while the input still says exactly that.
  const [submitted, setSubmitted] = useState<string | null>(null);
  const trimmed = term.trim();
  const debounced = useDebouncedValue(trimmed);
  const query = submitted === trimmed ? trimmed : debounced;

  const { currentData, error, isError, isFetching, refetch } = useSearchUsersQuery(
    query === '' ? skipToken : { q: query, limit: SEARCH_LIMIT_DEFAULT },
  );

  const { phase, results } = searchView({ trimmed, found: currentData?.items, failed: isError && !isFetching });

  const combobox = useCombobox({
    id,
    items: results,
    getKey: userKey,
    scope: location.key,
    onSelect: (user) => {
      void navigate(profilePath(user.id));
    },
  });
  const popupOpen = combobox.isOpen && phase !== 'idle';
  const listboxShown = combobox.inputProps['aria-expanded'];

  // `popupOpen` already rules out 'idle', which TypeScript narrows through the alias.
  const statusText = (() => {
    if (!popupOpen) {
      return '';
    }
    switch (phase) {
      case 'loading':
        return 'searching…';
      case 'error':
        return errorMessage(error);
      case 'empty':
        return `No people found for "${query}".`;
      case 'results':
        return countSentence(results.length);
    }
  })();

  // Outside clicks close the list even where the browser keeps focus in the input (touch, Safari).
  const closeOnOutsidePointer = useEffectEvent((event: PointerEvent) => {
    if (event.target instanceof Node && formRef.current?.contains(event.target) === true) {
      return;
    }
    combobox.close();
  });

  useEffect(() => {
    if (!popupOpen) {
      return undefined;
    }
    const listener = (event: PointerEvent) => {
      closeOnOutsidePointer(event);
    };
    document.addEventListener('pointerdown', listener);
    return () => {
      document.removeEventListener('pointerdown', listener);
    };
  }, [popupOpen]);

  const changeTerm = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setTerm(next);
    if (next.trim() === '') {
      combobox.close();
    } else {
      combobox.open();
    }
  };

  const searchNow = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (trimmed === '') {
      return;
    }
    setSubmitted(trimmed);
    combobox.open();
  };

  const closeWhenFocusLeaves = (event: FocusEvent<HTMLFormElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      combobox.close();
    }
  };

  // A press inside the popup must not take focus from the input (the combobox keeps focus while the list is open);
  // the click that follows still follows the link or presses "try again".
  const keepFocusInInput = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
  };

  return (
    <form
      ref={formRef}
      role="search"
      className="header-search"
      noValidate
      onSubmit={searchNow}
      onBlur={closeWhenFocusLeaves}
    >
      <label id={labelId} className="header-search__label" htmlFor={inputId}>
        find people
      </label>
      <input
        {...combobox.inputProps}
        id={inputId}
        className="header-search__input"
        type="text"
        value={term}
        onChange={changeTerm}
        maxLength={SEARCH_QUERY_MAX}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="search"
      />
      <div
        className={tokenList('header-search__popup', popupOpen && 'header-search__popup--open')}
        onMouseDown={keepFocusInInput}
      >
        <ul
          id={combobox.listboxId}
          className="header-search__list"
          role="listbox"
          aria-labelledby={labelId}
          hidden={!listboxShown}
        >
          {listboxShown
            ? results.map((user) => (
                <li key={user.id} className="header-search__item" role="none">
                  <Link
                    {...combobox.getOptionProps(user)}
                    className="header-search__option"
                    to={profilePath(user.id)}
                    tabIndex={-1}
                    onClick={combobox.close}
                  >
                    <Avatar
                      firstName={user.firstName}
                      lastName={user.lastName}
                      src={user.avatarUrl}
                      decorative
                      className="header-search__avatar"
                    />
                    <span className="header-search__name">{fullName(user)}</span>
                  </Link>
                </li>
              ))
            : null}
        </ul>
        <p
          className={tokenList(
            'header-search__status',
            phase === 'error' && 'header-search__status--error',
            phase === 'results' && 'visually-hidden',
          )}
          role="status"
        >
          {statusText}
        </p>
        {popupOpen && phase === 'empty' ? (
          <p className="header-search__hint">Try the beginning of a first or last name.</p>
        ) : null}
        {popupOpen && phase === 'error' ? (
          <Button
            className="header-search__retry"
            onClick={() => {
              void refetch();
            }}
          >
            try again
          </Button>
        ) : null}
      </div>
    </form>
  );
}
