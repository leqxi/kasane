## What this changes

<!-- One or two sentences. What is different afterwards, not what you did. -->

## Why

<!-- The situation an overlay is in that this fixes or makes possible. -->

## Checks

- [ ] `npm run check` passes
- [ ] `npm test` passes in Chromium, WebKit and Firefox
- [ ] A change to `src/` says what `npm run size` prints, before and after

## If this touches `src/`

- [ ] No layout is read between writes: every target is measured before any is written
- [ ] A scroll of the scroller still reads no element at all
- [ ] `revert()` removes everything the change writes

## If this touches the tests

- [ ] A new case is one situation an overlay can be in that no existing case already shows
- [ ] It is checked against what the browser painted, not against a number written down
