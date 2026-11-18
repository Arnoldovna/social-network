import { pick, type Random } from './content.js';

/**
 * Generated abstract avatars (DATA-MODEL.md, Avatar images): two or three flat colour fields from the maw accent
 * palette in one of six compositions. No faces, no stock photos, no third-party images, so nothing needs attribution.
 * Pure data and functions, shared by the API seed (which rasterises the SVG with sharp, `apps/api/src/db/seed/avatars.ts`)
 * and the GitHub Pages demo (which serves the SVG itself, ADR-0020).
 */

/** The maw accent palette (maw-design-system tokens `--color-<name>`). Data colours only, never UI chrome. */
export const AVATAR_PALETTE = {
  rose: '#e59797',
  sky: '#b8d3f3',
  sand: '#e1d7b5',
  olive: '#ad9234',
  apricot: '#f39945',
  blush: '#f5b7a9',
  rust: '#c36035',
  vermilion: '#f85d33',
} as const;

export type AvatarColour = keyof typeof AVATAR_PALETTE;

export const AVATAR_COMPOSITIONS = [
  'vertical-split',
  'horizontal-split',
  'corner-square',
  'centred-bar',
  'stacked-thirds',
  'offset-square',
] as const;

export type AvatarComposition = (typeof AVATAR_COMPOSITIONS)[number];

export interface AvatarDesign {
  readonly composition: AvatarComposition;
  /** Three distinct colours, background first; two-field compositions use the first two. */
  readonly colours: readonly [AvatarColour, AvatarColour, AvatarColour];
}

const SIZE = 512;
const COLOUR_NAMES = Object.keys(AVATAR_PALETTE).filter((name): name is AvatarColour => name in AVATAR_PALETTE);

/** A rectangle `[x, y, width, height]` on the 512 × 512 canvas. */
type Field = readonly [number, number, number, number];

/** The fields painted over the background (colour 0), in the order of colours 1 and 2. */
const FIELDS: Record<AvatarComposition, readonly Field[]> = {
  'vertical-split': [[256, 0, 256, 512]],
  'horizontal-split': [[0, 256, 512, 256]],
  'corner-square': [[256, 256, 256, 256]],
  'centred-bar': [[0, 192, 512, 128]],
  'stacked-thirds': [
    [0, 171, 512, 170],
    [0, 341, 512, 171],
  ],
  'offset-square': [
    [160, 64, 288, 288],
    [0, 416, 512, 96],
  ],
};

/** A composition and three distinct colours, chosen by `random` (deterministic for a seeded PRNG). */
export function pickAvatarDesign(random: Random): AvatarDesign {
  const composition = pick(AVATAR_COMPOSITIONS, random);
  const remaining = [...COLOUR_NAMES];
  const take = (): AvatarColour => {
    const colour = pick(remaining, random);
    remaining.splice(remaining.indexOf(colour), 1);
    return colour;
  };
  return { composition, colours: [take(), take(), take()] };
}

/** The design as a self-contained SVG document (no fonts, no external references, only rectangles). */
export function renderAvatarSvg({ composition, colours }: AvatarDesign): string {
  const rect = ([x, y, width, height]: Field, colour: AvatarColour): string =>
    `<rect x="${String(x)}" y="${String(y)}" width="${String(width)}" height="${String(height)}" fill="${AVATAR_PALETTE[colour]}"/>`;
  const fields = FIELDS[composition].map((field, index) => rect(field, index === 0 ? colours[1] : colours[2]));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(SIZE)}" height="${String(SIZE)}" viewBox="0 0 ${String(SIZE)} ${String(SIZE)}">`,
    rect([0, 0, SIZE, SIZE], colours[0]),
    ...fields,
    '</svg>',
  ].join('');
}
