import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import type { Kasane, KasaneOptions } from "../src/index.ts";

/*
  Every reading is checked against what the browser actually painted, never against a number written
  down here. The oracle is `document.elementsFromPoint()`, the hit test kasane exists to avoid: it is
  authoritative, because it asks the browser what it put on the screen, and far too expensive to
  ship, because it is a style and layout read per sample. That is exactly what makes it the right
  thing to check the arithmetic against.

  Each test builds the page it needs and loads the built library into it, so there is no fixture site
  to keep in step with the suite, and what runs is `dist/index.js` — the file a consumer installs.
*/

declare global {
  interface Window {
    __kasane: (target: string | Element | Iterable<Element>, options?: KasaneOptions) => Kasane;
    __controller: Kasane;
    /** Settles the stand-in for `document.fonts.ready`, so a test owns the moment fonts land. */
    __fonts: () => void;
    /** A target taken out of the page, still reachable to be read back. */
    __parked: HTMLElement;
  }
}

/** `dist/index.js` has no imports, so dropping `export` turns it into an injectable classic script. */
const LIBRARY = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8").replace(
  /^export /gm,
  "",
);

const STYLE = `
  * { box-sizing: border-box }
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif }
  #stage { position: relative; width: 600px; height: 300px; overflow: hidden; background: #808080 }
  /* Scroll anchoring would absorb content growing above the fold by moving the scroll offset to
     match, which is the browser hiding the very layout change some of these tests are about. */
  #scroll { position: absolute; inset: 0; overflow: auto; overflow-anchor: none }
  #scroll.row { display: flex }
  .band { min-height: 150px }
  #scroll.row .band { flex: 0 0 240px; min-height: 100% }
  .bar { position: absolute; top: 0; left: 0; right: 0; height: 56px; z-index: 2 }
  .col { position: absolute; top: 0; bottom: 0; left: 90px; width: 130px; z-index: 2 }
  .ink { background: #000 }
  .paper { background: #fff }
`;

const BANDS = `
  <div class="band ink" data-surface="ink"></div>
  <div class="band paper" data-surface="paper"></div>
  <div class="band ink" data-surface="ink"></div>
  <div class="band paper" data-surface="paper"></div>`;

const BAR = `<div class="bar" data-target="bar"></div>`;

/** The page itself as the scroller: sections in normal flow, and a bar fixed over them. */
const PAGE_STYLE = `
  * { box-sizing: border-box }
  body { margin: 0; font: 16px/1.4 system-ui, sans-serif }
  .zone { min-height: 400px }
  .bar { position: fixed; top: 0; left: 0; right: 0; height: 56px; z-index: 2 }
  .ink { background: #000 }
  .paper { background: #fff }
`;

const ZONES = `
  <div class="zone ink" data-surface="ink"></div>
  <div class="zone paper" data-surface="paper"></div>
  <div class="zone ink" data-surface="ink"></div>`;

/** Where the page has to be for a section edge to fall inside a bar fixed at the top. */
const PAGE_CROSSING = 380;

/**
 * The same bands behind something kasane does not watch. Growing the spacer moves every section
 * below it without changing the box of any observed element, which is the one layout change
 * nothing reports.
 */
const SHIFTED = `<div id="spacer"></div>${BANDS}`;

/** Where the scroller has to be for an edge to fall near the middle of the bar. */
const CROSSING = 122;

/** What kasane wrote on a target, read back off it. */
type Reading = { token: string | null; start: string | null; end: string | null; split: number | null };

/** What the browser put behind a target, sampled. */
type Painted = {
  tokens: Record<string, number>;
  split: number | null;
  start: string | null;
  end: string | null;
  extent: number;
};

/* --------------------------------------------------------------------------------------------- */

/** Builds the scene, loads the built library, and starts it on every `[data-target]`. */
async function scene(
  page: Page,
  options: {
    surfaces: string;
    targets: string;
    axis?: "block" | "inline";
    /** The writing direction of the scroller. */
    dir?: "ltr" | "rtl";
    /** Runs in the page once the scene stands, before kasane is started on it. */
    init?: () => void;
  },
) {
  const row = options.axis === "inline" ? "row" : "";

  await page.setContent(
    `<!doctype html><html><head><style>${STYLE}</style></head><body>
       <div id="stage">
         <div id="scroll" class="${row}" dir="${options.dir ?? "ltr"}">${options.surfaces}</div>
         ${options.targets}
       </div>
     </body></html>`,
  );

  await page.addScriptTag({ content: `${LIBRARY}\nwindow.__kasane = kasane;` });
  if (options.init) await page.evaluate(options.init);

  await page.evaluate((axis) => {
    const scroll = document.querySelector("#scroll") as HTMLElement;
    const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-target]"));
    window.__controller = window.__kasane(targets, { root: scroll, axis });
  }, options.axis ?? "block");

  await settle(page);
}

/** Two frames: one scheduled read, and the write after it. */
const settle = (page: Page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function scrollTo(page: Page, to: number) {
  await page.evaluate((at) => {
    const scroll = document.querySelector("#scroll") as HTMLElement;
    if (scroll.classList.contains("row")) scroll.scrollLeft = at;
    else scroll.scrollTop = at;
  }, to);
  await settle(page);
}

/**
 * The arrangement the README opens with: sections in the page itself, a bar fixed over them, and
 * kasane started on a selector. The document's own scroller is the default and the most used path
 * through the library, and it is the one every scene above deliberately avoids by passing a `root`.
 */
async function pageScene(page: Page, body: string, start: () => void) {
  await page.setContent(
    `<!doctype html><html><head><style>${PAGE_STYLE}</style></head><body>${body}</body></html>`,
  );

  await page.addScriptTag({ content: `${LIBRARY}\nwindow.__kasane = kasane;` });
  await page.evaluate(start);
  await settle(page);
}

async function scrollPage(page: Page, to: number) {
  await page.evaluate((y) => window.scrollTo(0, y), to);
  await settle(page);
}

/** Grows the spacer in a `SHIFTED` scene, moving every section below it. */
async function shift(page: Page, to: number) {
  await page.evaluate((height) => {
    (document.querySelector("#spacer") as HTMLElement).style.height = `${height}px`;
  }, to);
  await settle(page);
  await settle(page);
}

const read = (page: Page, name: string): Promise<Reading> =>
  page.evaluate((target) => {
    const element = document.querySelector(`[data-target="${target}"]`) as HTMLElement;
    const split = element.style.getPropertyValue("--kasane-split");
    return {
      token: element.getAttribute("data-kasane"),
      start: element.getAttribute("data-kasane-start"),
      end: element.getAttribute("data-kasane-end"),
      split: split === "" ? null : Number(split),
    };
  }, name);

const painted = (
  page: Page,
  name: string,
  options: { axis?: "block" | "inline"; surfaces?: string; attribute?: string } = {},
): Promise<Painted> =>
  page.evaluate(
    ([target, direction, selector, attribute]) => {
      const element = document.querySelector(`[data-target="${target}"]`) as HTMLElement;
      const rect = element.getBoundingClientRect();
      const vertical = direction === "block";
      const extent = vertical ? rect.height : rect.width;

      const at = (x: number, y: number) => {
        for (const found of document.elementsFromPoint(x, y)) {
          if (found.matches(selector)) return found.getAttribute(attribute);
        }
        return null;
      };

      const tokens: Record<string, number> = {};
      for (let y = rect.top + 0.5; y < rect.bottom; y += 4) {
        for (let x = rect.left + 0.5; x < rect.right; x += 4) {
          const token = at(x, y);
          if (token) tokens[token] = (tokens[token] ?? 0) + 1;
        }
      }

      // Three scan lines across the target. There is one edge only when all three agree on where it
      // is and on what lies either side of it.
      const lines = [0.25, 0.5, 0.75].map((fraction) => {
        const runs: { token: string | null; from: number }[] = [];
        const from = vertical ? rect.top : rect.left;
        const to = vertical ? rect.bottom : rect.right;

        for (let step = from + 0.5; step < to; step += 1) {
          const token = vertical
            ? at(rect.left + rect.width * fraction, step)
            : at(step, rect.top + rect.height * fraction);
          if (!runs.length || runs[runs.length - 1]?.token !== token) {
            runs.push({ token, from: step - 0.5 });
          }
        }
        return runs;
      });

      const nothing = { tokens, split: null, start: null, end: null, extent };

      const straight =
        lines.every((runs) => runs.length === 2 && runs.every((run) => run.token)) &&
        lines.every(
          (runs) => runs[0]?.token === lines[0]?.[0]?.token && runs[1]?.token === lines[0]?.[1]?.token,
        );
      if (!straight) return nothing;

      const edges = lines.map((runs) => runs[1]?.from ?? 0);
      const edge = edges.reduce((sum, value) => sum + value, 0) / edges.length;
      if (edges.some((value) => Math.abs(value - edge) > 1.5)) return nothing;

      return {
        tokens,
        split: (edge - (vertical ? rect.top : rect.left)) / extent,
        start: lines[0]?.[0]?.token ?? null,
        end: lines[0]?.[1]?.token ?? null,
        extent,
      };
    },
    [
      name,
      options.axis ?? "block",
      options.surfaces ?? "[data-surface]",
      options.attribute ?? "data-surface",
    ] as const,
  );

/** The token covering most of the target, which is what `data-kasane` should say. */
const dominant = (found: Painted) =>
  Object.entries(found.tokens).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

/**
 * How far the reported edge may sit from the scanned one, in pixels. The scan resolves to a pixel
 * and a section's edge is fractional, so kasane is the precise one of the two here: the tolerance
 * belongs to the oracle, and is stated in the unit the oracle can actually resolve.
 */
const TOLERANCE = 1.5;

/* --------------------------------------------------------------------------------------------- */

test.describe("what is behind an overlay", () => {
  test("is the surface the browser painted there", async ({ page }) => {
    await scene(page, { surfaces: BANDS, targets: BAR });

    const got = await read(page, "bar");

    expect(got.token).toBe(dominant(await painted(page, "bar")));
    expect(got.token).toBe("ink");
  });

  test("is reported on both sides of an edge, where the edge is", async ({ page }) => {
    await scene(page, { surfaces: BANDS, targets: BAR });
    await scrollTo(page, CROSSING);

    const got = await read(page, "bar");
    const want = await painted(page, "bar");

    expect(want.split, "the scene should put an edge through the bar").not.toBeNull();
    expect(got.start).toBe(want.start);
    expect(got.end).toBe(want.end);
    expect(got.split).not.toBeNull();

    const off = Math.abs((got.split ?? 0) - (want.split ?? 0)) * want.extent;
    expect(off, `edge off by ${off.toFixed(2)}px`).toBeLessThanOrEqual(TOLERANCE);
  });

  test("is the surface painted on top, not the one with the most area", async ({ page }) => {
    // A card covers the middle of the section it sits in. Area alone would hand the win to the
    // section, which runs the whole way behind the bar and is hidden for half of it.
    await scene(page, {
      surfaces: `
        <div class="band paper" data-surface="paper" style="position:relative;min-height:320px">
          <div class="ink" data-surface="ink"
               style="position:absolute;top:110px;left:0;right:0;height:120px"></div>
        </div>
        <div class="band paper" data-surface="paper"></div>`,
      targets: BAR,
    });
    await scrollTo(page, 80);

    const got = await read(page, "bar");
    const want = await painted(page, "bar");

    expect(got.start).toBe(want.start);
    expect(got.end).toBe(want.end);
    expect(got.end).toBe("ink");
  });

  test("can differ between two overlays over the same row", async ({ page }) => {
    // The cover takes the right half only, so the two chips are over different surfaces at the same
    // moment. That is the reading one sampled point cannot produce.
    await scene(page, {
      surfaces: `
        <div class="band ink" data-surface="ink" style="position:relative;min-height:320px">
          <div class="paper" data-surface="paper" style="position:absolute;inset:0 0 0 50%"></div>
        </div>`,
      targets: `
        <span data-target="left" style="position:absolute;top:20px;left:20px;width:60px;height:18px;z-index:2"></span>
        <span data-target="right" style="position:absolute;top:20px;right:20px;width:60px;height:18px;z-index:2"></span>`,
    });

    const [left, right] = [await read(page, "left"), await read(page, "right")];

    expect(left.token).toBe("ink");
    expect(right.token).toBe("paper");
    expect(left.split, "a corner through a target is not one edge").toBeNull();
    expect(right.split).toBeNull();
  });
});

test.describe("the page as its own scroller", () => {
  test("is what a call with no options measures against", async ({ page }) => {
    // `kasane(".site-header")`, which is how the README opens and how most of the library's use
    // will look: the document's scroller, `window.scrollY`, a fixed bar, and a selector for a
    // target. Every other scene here hands kasane a `root` and never walks this path.
    await pageScene(page, `${ZONES}<div class="bar" data-target="bar"></div>`, () => {
      window.__controller = window.__kasane(".bar");
    });
    await scrollPage(page, PAGE_CROSSING);

    const got = await read(page, "bar");
    const want = await painted(page, "bar");

    expect(want.split, "the scene should put an edge through the bar").not.toBeNull();
    expect(got.token).toBe(dominant(want));
    expect(got.start).toBe(want.start);
    expect(got.end).toBe(want.end);
    expect(await page.getAttribute('[data-target="bar"]', "data-kasane-axis")).toBe("block");

    const off = Math.abs((got.split ?? 0) - (want.split ?? 0)) * want.extent;
    expect(off, `edge off by ${off.toFixed(2)}px`).toBeLessThanOrEqual(TOLERANCE);
  });

  test("takes a selector, an element or a list, and says what it took", async ({ page }) => {
    await pageScene(page, `${ZONES}<div class="bar" data-target="bar"></div>`, () => {
      window.__controller = window.__kasane(".bar");
    });

    const took = await page.evaluate(() => {
      const bar = document.querySelector('[data-target="bar"]') as HTMLElement;
      const selector = window.__controller.targets;

      // Each call takes the target off the one before it, which is the documented behaviour; what
      // is being read here is only that all three ways of naming a target resolve to the same one.
      const element = window.__kasane(bar).targets;
      const list = window.__kasane([bar]).targets;

      return {
        counts: [selector.length, element.length, list.length],
        same: [selector[0], element[0], list[0]].every((found) => found === bar),
      };
    });

    expect(took).toEqual({ counts: [1, 1, 1], same: true });
  });

  test("reads the surfaces and the attribute it is pointed at", async ({ page }) => {
    await pageScene(
      page,
      `<div class="zone ink" data-theme="night"></div>
       <div class="zone paper" data-theme="day"></div>
       <div class="zone ink" data-theme="night"></div>
       <div class="bar" data-target="bar"></div>`,
      () => {
        window.__controller = window.__kasane(".bar", {
          surfaces: "[data-theme]",
          attribute: "data-theme",
        });
      },
    );
    await scrollPage(page, PAGE_CROSSING);

    const surfaces = { surfaces: "[data-theme]", attribute: "data-theme" };
    const got = await read(page, "bar");
    const want = await painted(page, "bar", surfaces);

    expect(want.split, "the scene should put an edge through the bar").not.toBeNull();
    expect(got.token).toBe(dominant(want));
    expect(got.start).toBe(want.start);
    expect(got.end).toBe(want.end);
    expect(got.start, "the token is the attribute's value, whatever the attribute is").toBe("night");
  });

  test("reports no edge at all when asked not to", async ({ page }) => {
    await pageScene(page, `${ZONES}<div class="bar" data-target="bar"></div>`, () => {
      window.__controller = window.__kasane(".bar", { split: false });
    });
    await scrollPage(page, PAGE_CROSSING);

    const got = await read(page, "bar");
    const want = await painted(page, "bar");

    expect(want.split, "an edge does cross the bar here").not.toBeNull();
    expect(got.token, "the surface is still reported").toBe(dominant(want));
    expect(got.start, "the edge is not").toBeNull();
    expect(got.end).toBeNull();
    expect(got.split).toBeNull();
    expect(await page.getAttribute('[data-target="bar"]', "data-kasane-axis")).toBeNull();
  });
});

test.describe("when there is no edge to report", () => {
  test("a gap gets the dominant surface and no split", async ({ page }) => {
    await scene(page, {
      surfaces: `
        <div class="band ink" data-surface="ink"></div>
        <div style="height:16px"></div>
        <div class="band paper" data-surface="paper"></div>
        <div class="band ink" data-surface="ink"></div>`,
      targets: BAR,
    });
    await scrollTo(page, 118);

    const got = await read(page, "bar");
    const want = await painted(page, "bar");

    expect(Object.keys(want.tokens).length, "the bar should span the seam").toBeGreaterThan(1);
    expect(want.split, "there is no one line to clip on").toBeNull();
    expect(got.token).toBe(dominant(want));
    expect(got.split).toBeNull();
  });

  test("no surface at all writes nothing", async ({ page }) => {
    await scene(page, { surfaces: `<div style="height:600px"></div>`, targets: BAR });

    const got = await read(page, "bar");

    expect(got.token, "a fallback token nobody asked for is worse than none").toBeNull();
    expect(got.split).toBeNull();
  });
});

test("a horizontal scroller splits across the inline axis", async ({ page }) => {
  await scene(page, {
    axis: "inline",
    surfaces: `
      <div class="band ink" data-surface="ink"></div>
      <div class="band paper" data-surface="paper"></div>
      <div class="band ink" data-surface="ink"></div>`,
    targets: `<div class="col" data-target="col"></div>`,
  });

  // Where a vertical edge lands in the column depends on the layout, so walk the scroller rather
  // than trusting one offset to be the interesting one.
  const found = await page.evaluate(async () => {
    for (let to = 0; to <= 400; to += 4) {
      (document.querySelector("#scroll") as HTMLElement).scrollLeft = to;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const element = document.querySelector('[data-target="col"]') as HTMLElement;
      if (element.style.getPropertyValue("--kasane-split")) return to;
    }
    return null;
  });

  expect(found, "an edge should cross the column somewhere").not.toBeNull();

  const got = await read(page, "col");
  const want = await painted(page, "col", { axis: "inline" });

  expect(await page.getAttribute('[data-target="col"]', "data-kasane-axis")).toBe("inline");
  expect(got.start).toBe(want.start);
  expect(got.end).toBe(want.end);
  expect(Math.abs((got.split ?? 0) - (want.split ?? 0)) * want.extent).toBeLessThanOrEqual(TOLERANCE);
});

test("the inline axis runs the way the text does", async ({ page }) => {
  // `block` and `inline` are CSS's logical axes, so a scroller in Arabic runs its inline axis right
  // to left and the surface at the start of it is the rightmost one, not the leftmost.
  await scene(page, {
    axis: "inline",
    dir: "rtl",
    surfaces: `
      <div class="band ink" data-surface="ink"></div>
      <div class="band paper" data-surface="paper"></div>
      <div class="band ink" data-surface="ink"></div>`,
    targets: `<div class="col" data-target="col"></div>`,
  });

  const got = await read(page, "col");
  const want = await painted(page, "col", { axis: "inline" });

  expect(want.split, "the scene should put an edge through the column").not.toBeNull();

  // The oracle scans left to right, which here is from the end of the inline axis back to its
  // start. A reading that matches it mirrored is a reading in the order the writing direction means
  // — and the one a physical left-to-right reading would get exactly backwards.
  expect(got.start).toBe(want.end);
  expect(got.end).toBe(want.start);
  expect(got.start).not.toBe(got.end);

  const off = Math.abs((got.split ?? 0) - (1 - (want.split ?? 0))) * want.extent;
  expect(off, `edge off by ${off.toFixed(2)}px`).toBeLessThanOrEqual(TOLERANCE);
});

test.describe("a layout change nothing reports", () => {
  test("is picked up by measure", async ({ page }) => {
    await scene(page, { surfaces: SHIFTED, targets: BAR });
    await scrollTo(page, 160);

    const before = await read(page, "bar");
    expect(before.token).toBe("paper");

    // The spacer is neither a surface nor a target, so growing it changes no observed element's own
    // box: every section below it moves and nothing tells kasane. That is the case measure() exists
    // for, so the reading has to still be the old one until it is called.
    await shift(page, 100);

    const stale = await read(page, "bar");
    expect(stale.token, "nothing observed this, so nothing should have reported it").toBe(before.token);
    expect(stale.token).not.toBe(dominant(await painted(page, "bar")));

    await page.evaluate(() => window.__controller.measure());

    const after = await read(page, "bar");
    expect(after.token).toBe(dominant(await painted(page, "bar")));
  });

  test("is picked up when web fonts land", async ({ page }) => {
    await scene(page, {
      surfaces: SHIFTED,
      targets: BAR,
      // Fonts land after the first paint and move everything below them. The real promise has long
      // settled by the time a page is built this way, so the test holds one of its own and settles
      // it at the moment it wants to check.
      init: () => {
        Object.defineProperty(document, "fonts", {
          configurable: true,
          value: {
            ready: new Promise<void>((resolve) => {
              Object.defineProperty(window, "__fonts", { configurable: true, value: resolve });
            }),
          },
        });
      },
    });
    await scrollTo(page, 160);

    const before = await read(page, "bar");
    expect(before.token).toBe("paper");

    await shift(page, 100);
    expect((await read(page, "bar")).token, "fonts have not landed yet").toBe(before.token);

    await page.evaluate(() => window.__fonts());
    await settle(page);
    await settle(page);

    const after = await read(page, "bar");
    expect(after.token).toBe(dominant(await painted(page, "bar")));
    expect(after.token).not.toBe(before.token);
  });
});

test.describe("the controller", () => {
  test("revert removes everything it wrote and stops following", async ({ page }) => {
    await scene(page, { surfaces: BANDS, targets: BAR });
    expect((await read(page, "bar")).token).not.toBeNull();

    await page.evaluate(() => window.__controller.revert());
    await scrollTo(page, 200);

    expect(await read(page, "bar")).toEqual({ token: null, start: null, end: null, split: null });
    expect(await page.getAttribute('[data-target="bar"]', "data-kasane-axis")).toBeNull();
  });

  test("a target that is not being painted reports nothing, hidden or removed", async ({ page }) => {
    await scene(page, {
      surfaces: BANDS,
      targets: `${BAR}
        <div class="bar" data-target="hidden" style="top:80px"></div>
        <div class="bar" data-target="other" style="top:160px"></div>`,
    });
    await scrollTo(page, CROSSING);

    expect((await read(page, "bar")).split, "the scene should put an edge through the bar").not.toBeNull();

    // Nothing is painted behind an element that is not on the page, and nothing is painted behind
    // one that is display:none either. Both are the state a target is already in before kasane's
    // first write, which is the state a stylesheet has to render sensibly anyway — so both say so,
    // rather than one of them holding on to a reading that stopped being true.
    await page.evaluate(() => {
      const bar = document.querySelector('[data-target="bar"]') as HTMLElement;
      bar.remove();
      window.__parked = bar;
      (document.querySelector('[data-target="hidden"]') as HTMLElement).style.display = "none";
    });

    await scrollTo(page, 240);
    await settle(page);

    const removed = await page.evaluate(() => {
      const element = window.__parked;
      return {
        token: element.getAttribute("data-kasane"),
        start: element.getAttribute("data-kasane-start"),
        end: element.getAttribute("data-kasane-end"),
        split: element.style.getPropertyValue("--kasane-split") || null,
      };
    });

    const nothing = { token: null, start: null, end: null, split: null };
    expect(removed, "a target off the page").toEqual(nothing);
    expect(await read(page, "hidden"), "a target that is display:none").toEqual(nothing);

    expect((await read(page, "other")).token, "the targets still being painted must follow").toBe(
      dominant(await painted(page, "other")),
    );
  });

  test("a second call takes a target off the first", async ({ page }) => {
    await scene(page, { surfaces: BANDS, targets: BAR });

    // Two controllers writing the same attributes would leave whichever lost the race in charge of
    // them, so starting on an owned target reverts the owner first.
    const still = await page.evaluate(async () => {
      const bar = document.querySelector('[data-target="bar"]') as HTMLElement;
      const scroll = document.querySelector("#scroll") as HTMLElement;
      const first = window.__controller;

      window.__controller = window.__kasane([bar], { root: scroll });
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

      first.revert();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return bar.getAttribute("data-kasane");
    });

    expect(still, "reverting the loser must not strip the winner's work").not.toBeNull();
  });
});

test.describe("what a scroll costs", () => {
  test("nothing, in layout reads", async ({ page }) => {
    await scene(page, { surfaces: BANDS, targets: BAR });

    // The page counts every getBoundingClientRect. kasane spends them when it reads, which a scroll
    // must not cause, so the count must not move while one runs.
    const spent = await page.evaluate(async () => {
      let count = 0;
      const rect = Element.prototype.getBoundingClientRect;
      Element.prototype.getBoundingClientRect = function patched(this: Element) {
        count += 1;
        return rect.call(this);
      };

      const scroll = document.querySelector("#scroll") as HTMLElement;
      for (let to = 20; to <= 300; to += 20) {
        scroll.scrollTop = to;
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      }

      Element.prototype.getBoundingClientRect = rect;
      return count;
    });

    expect(spent).toBe(0);
  });

  test("a layout change is read again", async ({ page }) => {
    await scene(page, { surfaces: BANDS, targets: BAR });
    const before = await read(page, "bar");

    // A surface that shrinks moves every surface under it. Nothing tells kasane; the ResizeObserver
    // does, and the reading has to follow. Without this, never measuring would also pass.
    await page.evaluate(() => {
      (document.querySelector("[data-surface]") as HTMLElement).style.minHeight = "20px";
    });
    await settle(page);
    await settle(page);

    const after = await read(page, "bar");

    expect(after.token).toBe(dominant(await painted(page, "bar")));
    expect(after.token).not.toBe(before.token);
  });
});
