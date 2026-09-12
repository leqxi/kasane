# kasane (重ね)

Tells an overlay which surface it is layered over, and where the boundary crosses it.

kasane (重ね) is the layering of one thing over another. A fixed header, a floating logo, a side
rail or a custom cursor sits above a page of sections that each paint their own colour, and it has
to stay legible over all of them.

The usual answer is to hit test — `document.elementsFromPoint()` on every scroll frame, read what
came back, swap a colour. That costs a style and layout recalc per frame, it samples one point for
a whole bar, and it ends in a cross fade that leaves the element a blend of two colours which is
guaranteed against neither background.

kasane reads no element at all while a page scrolls, answers for each overlay separately, and
reports the edge, so a clip can sit exactly on it instead of a fade guessing across it.

**One ES module, about 2.0 kB minified and gzipped, no dependencies.**

```sh
npm install @leqxi/kasane
```

## Use

```js
import { kasane } from "@leqxi/kasane";

kasane(".site-header");
```

Every element matching `[data-surface]` declares a surface. Its attribute value is the token, and
kasane copies whichever one is behind the overlay onto it as `data-kasane`. What that token means is
yours:

```html
<header class="site-header">kasane</header>

<section data-surface="ink">…</section>
<section data-surface="cream">…</section>
```

```css
.site-header[data-kasane="ink"] { color: white; }
.site-header[data-kasane="cream"] { color: black; }
```

Or skip the map entirely and let the surface's own colour decide, with no script involved:

```css
[data-surface] { background: var(--surface); }

.site-header {
  color: oklch(from var(--surface) clamp(0, (0.6 - l) * 1e3, 1) 0 0);
}
```

## The edge

When a single straight edge crosses an overlay, kasane also reports the surface on each side of it
and how far down the overlay it falls. Two layers clipped to meet on that fraction give an overlay
that is legible on both surfaces at once, with no frame that is a blend of the two:

```html
<header class="site-header">
  <span class="face">kasane</span>
  <span class="face face-end" aria-hidden="true">kasane</span>
</header>
```

```css
/* The split is a fraction OF THE TARGET, so the box being clipped has to be the target's box:
   the target is the grid and each layer fills one cell of it. Wrapping the layers in anything
   smaller clips a different box, and the edge lands somewhere visibly wrong. Whatever positions
   the content inside a layer belongs on the layer, never on the target. */
.site-header { display: grid; }
.site-header > .face { grid-area: 1 / 1; }

.face {
  color: var(--on-start);
  clip-path: inset(0 0 calc(100% - var(--kasane-split, 1) * 100%) 0);
}

.face-end {
  color: var(--on-end);
  clip-path: inset(calc(var(--kasane-split, 1) * 100%) 0 0 0);
}
```

An edge is only reported when there is honestly one to report. A gap between two sections, a
section shorter than the overlay, a card floating in the middle of one, or a panel covering half
its width all leave the split attributes off: kasane reports the dominant surface and nothing else,
and the `, 1` fallback above keeps the first layer whole.

### Which side the split starts from

The two sides are the axis's own, not the screen's. On the block axis `data-kasane-start` is the
surface above the edge. On the inline axis it is the one the writing direction starts from — the
right-hand surface on an Arabic page, the top one in vertical Japanese — and `--kasane-split` is
the fraction measured from that same side.

`clip-path: inset()` has no logical form, which is what `data-kasane-axis` is for. The inline pair,
and the same two clips with their ends swapped for a page that runs the other way:

```css
[data-kasane-axis="inline"] .face {
  clip-path: inset(0 calc(100% - var(--kasane-split, 1) * 100%) 0 0);
}
[data-kasane-axis="inline"] .face-end {
  clip-path: inset(0 0 0 calc(var(--kasane-split, 1) * 100%));
}

[dir="rtl"] [data-kasane-axis="inline"] .face {
  clip-path: inset(0 0 0 calc(100% - var(--kasane-split, 1) * 100%));
}
[dir="rtl"] [data-kasane-axis="inline"] .face-end {
  clip-path: inset(0 calc(var(--kasane-split, 1) * 100%) 0 0);
}
```

## What it writes

On each target, and only while there is something to say:

| | |
| --- | --- |
| `data-kasane` | The token of the surface the overlay is mostly over. |
| `data-kasane-start` | The token before the edge — above it, or before it in the writing direction. |
| `data-kasane-end` | The token after the edge. |
| `--kasane-split` | Where the edge falls, `0`–`1` of the target's own extent. |
| `data-kasane-axis` | `block` or `inline`, so one stylesheet can clip either way. |

The last four appear together or not at all. kasane chooses no colours, adds no styles and animates
nothing — that is what keeps it correct under `forced-colors`, where the system owns the colours and
a library that painted them would be fighting it.

## API

```ts
kasane(target, options?): Kasane
```

`target` is a selector, an element, or any iterable of elements.

| Option | Default | |
| --- | --- | --- |
| `surfaces` | `"[data-surface]"` | Selector for the elements that declare a surface. |
| `attribute` | `"data-surface"` | Attribute the token is read from. Point it at what your sections already carry. |
| `axis` | `"block"` | The axis an edge is measured along, in CSS's own terms: `"block"` runs down the page, `"inline"` along the writing direction. `"inline"` for a sideways scroller. |
| `split` | `true` | Report where an edge crosses a target. |
| `root` | `null` | The scroller the surfaces live in. Defaults to the document's. |

The returned controller:

| | |
| --- | --- |
| `targets` | The elements kasane writes on. |
| `measure()` | Read and write again. For a layout change kasane cannot see — content that arrived without changing any observed element's own box. |
| `revert()` | Remove everything written, and stop observing. |

Calling `kasane()` on a target another controller already owns reverts that one first, so two
controllers never fight over the same attributes.

A target that is not being painted — hidden, or taken out of the page — reports nothing, and says
so again when it comes back. That is the same state it is in before the first write, so a
stylesheet that reads correctly without kasane reads correctly here too.

### A scroller of its own

`root` measures everything against one element's box instead of the document's, so a panel, a
modal or a horizontal strip works the way a page does — and a target pinned outside the scroller
still resolves against what scrolls under it.

```js
kasane(".panel-header", { root: document.querySelector(".panel"), axis: "block" });
```

## How it avoids the work

A section does not move in document space when you scroll, so its box is measured once and
scrolling is arithmetic on `scrollY`. Measuring happens again when the layout actually changes,
which a `ResizeObserver` reports, and once more when web fonts land.

Reads and writes are never interleaved. Every target is measured first, against a layout that is
still clean, and every write happens after — so a page of overlays costs the one layout a single
overlay does.

A target is cut into bands at every surface edge that falls inside it, and each band goes to the
surface painted on top of it, which is the last one in document order covering it. Area alone would
hand a section that runs the whole way behind an overlay the win over a card painted on top of half
of it, and the card is what the eye sees.

## Browser support

Any browser with `ResizeObserver` — Chrome, Edge, Firefox and Safari 13.1+. Nothing in the library
needs `oklch()`; the examples above use it because picking a foreground from a background is nicer
in CSS than in script, and a `data-kasane` attribute map works everywhere.

## Development

```sh
npm install
npm run build       # dist/, which is what the tests load and what npm ships
npm test            # against the browser, in Chromium, WebKit and Firefox
npm run check       # types and lint
npm run size        # what the built module actually weighs
npm run check.size  # the same, against the budget the size above is stated from
npm run fix         # apply the lint fixes that are safe to apply
```

The source is laid out by hand, so Biome lints it but does not format it: a signature broken across
lines that would fit on one, or a comment wrapped to read as a paragraph, is a choice rather than an
oversight. `.editorconfig` carries the indentation.

The size in this README is a budget in `scripts/size.mjs`, and CI fails when the build outgrows it.
Raising it is the right move for a change worth the bytes — in the same commit as the sentence above
that it makes untrue.

Every reading is checked against an oracle that is not kasane: `document.elementsFromPoint()`, the
hit test kasane exists to avoid. It is authoritative, because it asks the browser what it actually
painted, and far too expensive to ship — which is exactly what makes it the right thing to check the
arithmetic against.

Each test builds the page it needs and loads `dist/index.js` into it, so there is no fixture site to
keep in step with the suite, and what is exercised is the file a consumer actually installs.

## License

MIT
