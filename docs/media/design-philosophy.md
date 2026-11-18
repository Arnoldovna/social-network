# Design philosophy: Ruled Acquaintance

The two images in this folder, `social-preview.png` (1280 × 640, the GitHub social preview) and `cover.png`
(1600 × 800, the same composition at 1.25×), follow the philosophy below. It is the maw-studio identity
(see the `maw-design-system` skill) applied to a still image, and the third sheet in a series with Imageboard
("Ruled Field") and petition ("Ruled Assent").

## The movement

**Ruled Acquaintance** holds that a relationship can be drawn as a table. Two people meet where a row crosses a
column, and the whole fabric of who knows whom can be laid out on ruled paper, read like a timetable, and checked
with a fingertip. The movement treats that table as a drawing rather than as data: a field of hairlines and small
square marks whose pattern carries the meaning, with words reduced to the numbers in the margin. The sheet should
look as if it had been ruled by hand on a drafting table over many evenings, every mark placed with a loupe and
checked twice. Nothing in it should look generated, decorated or "designed at".

Space is cut once. The paper holds the name; one flat field of colour holds the structure. The field is a spot
colour laid down as a solid plane with a hard edge that runs off the sheet, so it reads as material rather than as
a panel. Its top edge is not drawn separately: the header rule on the paper simply continues and becomes it. Inside
the field there is only black, in two kinds of mark: the 1px rule and the filled square. There are no boxes, no
rounded corners, no shadows and no gradients. Depth is refused so that the eye reads interval, alignment and
repetition instead.

Tone comes from density, never from tint. A solid square is a full mark. A square built from 1px rules set 1px
apart is half a mark: the same footprint, half the ink. The difference is visible at arm's length and exact up
close, the way an engraver gets grey from black lines alone. One hairline crosses the table on the diagonal, the
axis around which every mutual mark is mirrored. It is the only line that is not horizontal, and it earns its place
by explaining the symmetry without a word.

Scale works in two registers: monumental and whispered. The name is set very large in a regular weight, broken
across two lines at its own hyphen, so that the joining stroke sits alone at the end of the first line like a
connection waiting for its other half. Everything else is small, tracked and lowercase: indices, a legend, a stack,
a single plain sentence. There is nothing in between and never more than two weights. Uniform spacing is the tell
of a template; here every interval is tuned by eye against its neighbours by someone who has done this for years.

The grid crosses its own boundary. Baselines on the paper sit on rules in the field: the top of the first letter
touches the table's first rule, both lines of the name stand on row rules, the sentence stands on the last rule, and
the footnote and the legend share one baseline across the cut. The alignment is the meaning: the name and the
structure are one sentence. The result should feel meticulously crafted, the product of deep expertise and
painstaking patience, the kind of quiet sheet a typographer would pin to the wall and keep.

## How the social-network images express it

- **The cut:** paper on the left; a rose `#E59797` field (social-network's accent in the maw palette) from x 768 to
  the right edge and from the header rule (y 116) to the bottom edge.
- **The table is the real seed:** 14 rows and 14 columns are the 14 fictional demo people in insertion order
  (`packages/shared/src/demo-seed/people.ts`), so `01` is Mira Novak, the demo login. The marks are the friendship graph from
  `packages/shared/src/demo-seed/content.ts`: ten accepted friendships drawn as solid squares in both cells (mirrored across
  the diagonal), three open requests drawn as ruled half-tone squares in the requester's row only (Sofia and Yusuf to
  Mira, Mira to Clara). Row `01` shows Mira's five friends and her outgoing request; column `01` shows the two
  incoming requests that make the nav badge read 2.
- **The hyphen:** "social-" / "network" breaks at the hyphen, which stands at the end of the first line like a link
  to the second.
- **The shared lines:** the `l` ascender of "social-" meets the table's top rule; the baselines of the two wordmark
  lines sit on the rules under rows 04 and 09; the line "Make friends, write on walls, chat in real time." sits on
  the last rule; "rebuilt from a 2018 bootcamp project" and the legend share the bottom baseline.
- **Header:** `03 / 03` (the third of the three rebuilt projects, continuing Imageboard's `01 / 03`) left, the stack
  `react 19 · express 5 · socket.io` right, closed by one 1px ink rule that runs into the field.
- **Safe area:** all text and marks sit inside x 96–1184 and y 74–561 on the 1280 × 640 canvas (ink measured on the
  render). Only the colour field bleeds to the edges, so crops on social platforms (for example 1.91:1) lose nothing
  that carries meaning.
- **Contrast:** ink on paper (21:1), black on rose (9.21:1), secondary text `#606060` on paper only (6.29:1). No white
  on the accent, no grey on the accent, no rule-grey on the accent.

## Type and licences

Only Schibsted Grotesk (SIL Open Font License 1.1), weight 400, loaded from the repo's own
`@fontsource/schibsted-grotesk` 5.3.0 package (latin subset, every character used is in it); the licence is in
`LICENSES/OFL-SchibstedGrotesk.txt`. No other font is used, and no commercial font is involved. Colours are maw
tokens only: paper `#FFFFFF`, ink `#000000`, ink-muted `#606060`, rose `#E59797`.

## How the images were made

A generated HTML page holding one inline SVG (absolutely positioned text, 1px `rect` rules on whole pixels, square
marks, one diagonal `line`), with `@font-face` rules embedding the fontsource woff2 files, rendered by Playwright's
Chromium with `deviceScaleFactor: 1`. The cover is not an upscale: the layout is recomputed at 1.25× (cell pitch 24 →
30px) with positions rounded to whole pixels, so rules stay a crisp 1px. The renderer loads both font faces
explicitly and fails if they are not loaded, so a fallback font can never end up in the image.

## Using the images

- **Social preview:** GitHub, repository settings, "Social preview", upload `docs/media/social-preview.png`. This is
  a manual step in the GitHub UI; there is no API for it.
- **Cover:** `cover.png` is optional. The README plan (`portfolio-readme`) opens with the title, the one-line pitch,
  badges and a real desktop screenshot, as the Imageboard and petition READMEs do, so the cover is not placed there by
  default. If it is wanted, it goes directly under the title with alt text such as: "social-network: the project name
  beside a rose field holding a table of the 14 demo people, with filled squares for friendships and ruled squares for
  open requests".
