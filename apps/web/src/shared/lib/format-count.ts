const countFormat = new Intl.NumberFormat('en-GB');

/** A count with British digit grouping, as every visible number in the UI: "1,284" (maw-design-system §10). */
export function formatCount(count: number): string {
  return countFormat.format(count);
}

/** The count and the noun that fits it: `pluralize(1, 'person', 'people')` is "1 person", 1284 gives "1,284 people". */
export function pluralize(count: number, one: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}
