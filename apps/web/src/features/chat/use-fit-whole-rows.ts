import { useLayoutEffect } from 'react';
import type { RefObject } from 'react';

import { isScrolledToBottom, scrollToEnd } from './use-stick-to-bottom';

/** The custom property ChatLog.css reads as the scroller's block size (unset = natural height up to the cap). */
const FIT_PROPERTY = '--chat-log-fit-block-size';

/** Rounding slack for fractional row heights, so a row that fits exactly is never dropped. */
const SUBPIXEL_PX = 0.5;

/**
 * The block size of a log capped at `capPx` that shows only whole rows when it is scrolled to the end: the rows from
 * the newest backwards while they fit, plus the container's own border and padding (`chromePx`). `null` when nothing
 * needs fitting: all rows (`totalPx`) fit without scrolling, or the newest row alone is taller than the cap (it
 * scrolls). `newestFirst` is consumed lazily, so only the rows on screen are ever measured.
 */
export function fitWholeRows(
  capPx: number,
  chromePx: number,
  totalPx: number,
  newestFirst: Iterable<number>,
): number | null {
  const available = capPx - chromePx + SUBPIXEL_PX;
  if (totalPx <= available) {
    return null;
  }
  let fitted = 0;
  for (const height of newestFirst) {
    if (fitted + height > available) {
      break;
    }
    fitted += height;
  }
  return fitted === 0 ? null : fitted + chromePx;
}

function pixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Row heights from the newest backwards, read one row at a time. */
function* heightsNewestFirst(list: Element): Generator<number> {
  for (let row = list.lastElementChild; row !== null; row = row.previousElementSibling) {
    yield row.getBoundingClientRect().height;
  }
}

function measure(element: HTMLElement): number | null {
  const style = getComputedStyle(element);
  const cap = pixels(style.maxBlockSize);
  const list = element.querySelector(':scope > ol');
  if (cap <= 0 || list === null || list.childElementCount === 0) {
    return null;
  }
  const chrome =
    pixels(style.borderBlockStartWidth) +
    pixels(style.paddingBlockStart) +
    pixels(style.paddingBlockEnd) +
    pixels(style.borderBlockEndWidth);
  return fitWholeRows(cap, chrome, list.getBoundingClientRect().height, heightsNewestFirst(list));
}

function apply(element: HTMLElement, size: number | null): void {
  const wasAtBottom = isScrolledToBottom(element);
  if (size === null) {
    element.style.removeProperty(FIT_PROPERTY);
  } else {
    element.style.setProperty(FIT_PROPERTY, `${String(size)}px`);
  }
  if (wasAtBottom) {
    scrollToEnd(element);
  }
}

/**
 * Whether a content change needs a new fit: the log has none yet (it may just have started to overflow), or the rows
 * no longer fill the fitted size (rows were removed). A fitted log that keeps overflowing keeps its size, so new
 * messages never move the composer below it.
 */
function needsRefit(element: HTMLElement): boolean {
  return element.style.getPropertyValue(FIT_PROPERTY) === '' || element.scrollHeight <= element.clientHeight;
}

/**
 * Sizes the chat log so that, resting at the newest message, its top edge falls between two rows instead of through
 * one (ADR-0015: a half-cut message under the log's rule read as a rendering fault). The fit is computed when the
 * first rows render, when the web font has loaded (it changes row heights), when the log's width or the viewport
 * changes (window resize), and when its content changes while it has no fit yet or no longer fills it (it starts to
 * overflow, rows were removed). A log that stays fitted keeps its size as messages arrive, so the composer below it
 * never jumps while someone types; scrolled up, rows are cut as in any scroll container. Measurements are batched to
 * one per animation frame.
 */
export function useFitWholeRows(ref: RefObject<HTMLElement | null>, hasRows: boolean): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    if (!hasRows) {
      element.style.removeProperty(FIT_PROPERTY);
      return undefined;
    }

    let frame: number | undefined;
    let force = false;
    const schedule = (always: boolean) => {
      force ||= always;
      frame ??= requestAnimationFrame(() => {
        frame = undefined;
        if (force || needsRefit(element)) {
          apply(element, measure(element));
        }
        force = false;
      });
    };

    apply(element, measure(element));
    let active = true;
    // Only while the web font is still loading (it changes row heights). `document.fonts` is missing in some test DOMs.
    if ('fonts' in document && document.fonts.status !== 'loaded') {
      void document.fonts.ready.then(() => {
        if (active) schedule(true);
      });
    }
    const onResize = () => {
      schedule(true);
    };
    window.addEventListener('resize', onResize);
    const list = element.querySelector(':scope > ol');
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            schedule(false);
          });
    if (list !== null) observer?.observe(list);

    return () => {
      active = false;
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [ref, hasRows]);
}
