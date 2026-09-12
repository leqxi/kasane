# Changelog

All notable changes to kasane are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and kasane follows
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- `axis` is now the logical axis its name says it is. `"inline"` measured `left`/`right` and
  `"block"` measured `top`/`bottom` whatever the page's writing direction was, so on an Arabic page
  `data-kasane-start` named the surface at the *end* of the inline axis and `--kasane-split` was the
  fraction from the wrong side; a vertical writing mode had both axes on the wrong one entirely.
  kasane now resolves `writing-mode` and `direction` in the read phase and measures along the axis
  CSS means. Nothing changes for a left-to-right, horizontal page.

## [0.1.0]

First release.

- `kasane(target, options)` reports which surface each overlay is layered over, as `data-kasane`.
- Where a single straight edge crosses an overlay, it also reports the surface on each side
  (`data-kasane-start`, `data-kasane-end`), the fraction of the overlay the edge falls on
  (`--kasane-split`) and the axis it runs along (`data-kasane-axis`).
- No layout read while a scroller scrolls: surfaces are measured once and scrolling is arithmetic.
  Measuring happens again only when the layout changes, which a `ResizeObserver` reports.
- `root` scopes everything to one scroller, so a panel, a modal or a horizontal strip works the way
  the document does. `axis: "inline"` measures across the writing direction instead of down.
- `measure()` re-reads on demand; `revert()` removes everything written and stops observing.

[unreleased]: https://github.com/leqxi/kasane/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/leqxi/kasane/releases/tag/v0.1.0
