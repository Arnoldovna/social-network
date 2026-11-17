// @vitest-environment node
// Guards for the global stylesheets (ADR-0015, F-99, F-103, F-104). They read the CSS as text, so they test the
// source of truth itself: the token values, the contrast pairs they promise and the file structure main.css relies on.
import { describe, expect, it } from 'vitest';

/*
 * Vitest replaces every `.css` import (including `?raw`) with an empty string unless CSS processing is enabled, and
 * the web tsconfig carries browser types only. The files are therefore read with Node's fs, loaded through
 * `process.getBuiltinModule` and typed by the two calls used here.
 */
interface FileSystem {
  readonly readFileSync: (path: URL, encoding: 'utf8') => string;
  readonly readdirSync: (path: URL, options: { recursive: true }) => string[];
}
interface NodeProcess {
  readonly getBuiltinModule: (id: 'node:fs') => FileSystem;
}
const { readFileSync, readdirSync } = (globalThis as unknown as { process: NodeProcess }).process.getBuiltinModule(
  'node:fs',
);

const STYLES_DIR = new URL('../', import.meta.url);
const SRC_DIR = new URL('../../', import.meta.url);
const readStylesheet = (name: string): string => readFileSync(new URL(name, STYLES_DIR), 'utf8');

const baseCss = readStylesheet('base.css');
const mainCss = readStylesheet('main.css');
const tokensCss = readStylesheet('tokens.css');
const utilitiesCss = readStylesheet('utilities.css');

const ACCENTS = ['apricot', 'sky', 'olive', 'sand', 'vermilion', 'rose', 'blush', 'rust'] as const;
/** WCAG 2.2 AA: 4.5:1 for text (1.4.3), 3:1 for UI boundaries and focus indicators (1.4.11). */
const TEXT_MIN = 4.5;
const UI_MIN = 3;

type Palette = Readonly<Record<string, string>>;

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the first `{ … }` block that follows `prelude`, with nested braces balanced. */
function blockAfter(css: string, prelude: string): string {
  const start = css.indexOf(prelude);
  if (start === -1) throw new Error(`No block "${prelude}" in the stylesheet.`);
  const open = css.indexOf('{', start + prelude.length);
  let depth = 0;
  for (let index = open; index < css.length; index++) {
    if (css[index] === '{') depth++;
    if (css[index] === '}' && --depth === 0) return css.slice(open + 1, index);
  }
  throw new Error(`Unbalanced block "${prelude}".`);
}

/** Direct `--color-*` declarations of a block, references (`var(--color-x)`) kept as written. */
function colorDeclarations(block: string): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/--color-([a-z-]+):\s*([^;]+);/g)) {
    if (name !== undefined && value !== undefined && value.trim() !== 'initial') declarations[name] = value.trim();
  }
  return declarations;
}

function resolveColor(palette: Palette, name: string, seen: readonly string[] = []): string {
  const value = palette[name];
  if (value === undefined) throw new Error(`Token --color-${name} is not defined.`);
  const reference = /^var\(--color-([a-z-]+)\)$/.exec(value)?.[1];
  if (reference === undefined) return value.toLowerCase();
  if (seen.includes(reference)) throw new Error(`Circular colour token --color-${name}.`);
  return resolveColor(palette, reference, [...seen, name]);
}

function relativeLuminance(hex: string): number {
  const digits = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(hex)?.[1];
  if (digits === undefined) throw new Error(`"${hex}" is not a hex colour.`);
  const full = digits.length === 3 ? digits.replace(/[0-9a-f]/g, '$&$&') : digits;
  const [red, green, blue] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(palette: Palette, foreground: string, background: string): number {
  const [lighter, darker] = [resolveColor(palette, foreground), resolveColor(palette, background)]
    .map(relativeLuminance)
    .sort((a, b) => b - a) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

const tokens = stripComments(tokensCss);
const theme = blockAfter(tokens, '@theme static');
const forcedDark = colorDeclarations(blockAfter(tokens, ":root[data-theme='dark']"));
const preferredDark = colorDeclarations(
  blockAfter(blockAfter(tokens, '@media (prefers-color-scheme: dark)'), ":root:not([data-theme='light'])"),
);
const light: Palette = colorDeclarations(theme);
const dark: Palette = { ...light, ...forcedDark };

describe('tokens.css', () => {
  it('uses the rose accent of social-network (#e59797, ADR-0015)', () => {
    expect(light['accent']).toBe('var(--color-rose)');
    expect(resolveColor(light, 'accent')).toBe('#e59797');
  });

  it('resets every Tailwind default namespace, so shadows, radii and the default palette cannot be applied', () => {
    for (const namespace of ['color', 'font', 'font-weight', 'text', 'radius', 'shadow', 'drop-shadow', 'blur']) {
      expect(theme).toContain(`--${namespace}-*: initial;`);
    }
  });

  it('defines the same dark palette for the forced and the preferred dark theme', () => {
    expect(Object.keys(forcedDark).length).toBeGreaterThan(0);
    expect(preferredDark).toEqual(forcedDark);
  });

  it('keeps the accents and the text on them unchanged in dark mode', () => {
    for (const name of [...ACCENTS, 'accent', 'on-accent']) expect(forcedDark).not.toHaveProperty(name);
  });

  it('sets the Schibsted Grotesk stack and nothing else', () => {
    expect(/--font-sans:\s*([^;]+);/.exec(theme)?.[1]).toBe("'Schibsted Grotesk', 'Helvetica Neue', Arial, sans-serif");
  });

  it('has no type size below 12px (F-104)', () => {
    const sizes = [...theme.matchAll(/--text-([a-z-]+):\s*([\d.]+)rem;/g)].map(([, , rem]) => Number(rem));
    expect(sizes.length).toBeGreaterThan(5);
    for (const rem of sizes) expect(rem * 16).toBeGreaterThanOrEqual(12);
  });
});

describe.each([
  ['light', light],
  ['dark', dark],
] as const)('WCAG AA contrast in the %s theme', (_theme, palette) => {
  it.each([
    ['ink', 'paper'],
    ['ink-muted', 'paper'],
    ['ink', 'surface'],
    ['ink-muted', 'surface'],
    ['on-accent', 'accent'],
  ])('text %s on %s meets 4.5:1', (foreground, background) => {
    expect(contrast(palette, foreground, background)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it.each(ACCENTS)('on-accent text on the %s data colour meets 4.5:1', (accent) => {
    expect(contrast(palette, 'on-accent', accent)).toBeGreaterThanOrEqual(TEXT_MIN);
  });

  it.each([
    ['input underline (ink-muted)', 'ink-muted', 'paper'],
    ['focus ring (ink)', 'ink', 'paper'],
    ['focus ring inside an accent field (on-accent)', 'on-accent', 'accent'],
    ['error marker', 'error', 'paper'],
  ])('%s on its background meets 3:1', (_label, foreground, background) => {
    expect(contrast(palette, foreground, background)).toBeGreaterThanOrEqual(UI_MIN);
  });
});

describe('main.css', () => {
  it('imports Tailwind without template scanning, then tokens, base and utilities, and nothing else', () => {
    const imports = [...stripComments(mainCss).matchAll(/@import\s+([^;]+);/g)].map(([, target]) => target?.trim());
    expect(imports).toEqual(["'tailwindcss' source(none)", "'./tokens.css'", "'./base.css'", "'./utilities.css'"]);
  });
});

describe('base.css and utilities.css', () => {
  it.each([
    ['base.css', baseCss, 'base'],
    ['utilities.css', utilitiesCss, 'components'],
  ])('%s wraps every rule in @layer %s', (_file, css, layer) => {
    const source = stripComments(css).trim();
    expect(source.startsWith(`@layer ${layer} {`)).toBe(true);
    expect(blockAfter(source, `@layer ${layer}`).length).toBe(source.length - `@layer ${layer} {`.length - 1);
  });

  it('never removes the focus ring and falls back to ink when no accent field overrides it', () => {
    expect(blockAfter(stripComments(baseCss), ':focus-visible')).toContain(
      'outline: var(--focus-width) solid var(--focus-color, var(--color-ink));',
    );
  });

  it('shows the skip link whenever it has focus', () => {
    expect(blockAfter(stripComments(utilitiesCss), '.skip-link:focus')).toContain('translate: 0 0;');
  });
});

describe('ownership of the helper classes (ADR-0015)', () => {
  const stylesheets = readdirSync(SRC_DIR, { recursive: true })
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => path.endsWith('.css'))
    .map((path) => ({ path, css: stripComments(readFileSync(new URL(path, SRC_DIR), 'utf8')) }));

  it('finds the project stylesheets', () => {
    expect(stylesheets.map(({ path }) => path)).toContain('styles/utilities.css');
  });

  it.each(['visually-hidden', 'skip-link'])('only utilities.css defines .%s', (className) => {
    const selector = new RegExp(`\\.${className}(?![\\w-])`);
    const owners = stylesheets.filter(({ css }) => selector.test(css)).map(({ path }) => path);
    expect(owners).toEqual(['styles/utilities.css']);
  });
});
