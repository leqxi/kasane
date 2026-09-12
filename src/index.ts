// kasane: tells an overlay which surface it is layered over, and where the boundary crosses it.
// A fixed header, a floating logo, a side rail or a custom cursor sits above a page of sections
// that each paint their own colour, and it has to stay legible over all of them. The usual answer
// is to hit test: `document.elementsFromPoint()` on every scroll frame, read what came back, swap
// a colour. A hit test is a style and layout read, so that answer costs a recalc per frame, it
// samples one point for a whole bar, and it ends in a cross fade that leaves the element a blend
// of two colours that is guaranteed against neither background.
//
// kasane does no layout read while the page scrolls. A section does not move in document space
// when you scroll, so its box is measured once and scrolling is arithmetic on `scrollY`. The
// expensive read happens when the layout actually changes, which a `ResizeObserver` reports.
//
// Two phases, never interleaved: every measurement happens first, against a layout that is still
// clean, and every write after. Every target is measured before any is written, so a page of
// overlays costs the one layout a single overlay does. A read between writes forces a reflow and
// is a regression even when the output is right.
//
// kasane only reports. It writes the surface's own token on the target (`data-kasane`), the two
// tokens either side of a boundary that crosses it (`data-kasane-start`, `data-kasane-end`), the
// fraction of the target where that boundary lies (`--kasane-split`) and the axis it runs on
// (`data-kasane-axis`). It chooses no colours, adds no styles and animates nothing: the consumer
// owns the look, in CSS. That is also what keeps it right under `forced-colors`, where the system
// owns the colours and a library that painted them would be fighting it.
//
// Dependency-free on purpose: it ships to other projects as-is.

/** The axis a boundary between two surfaces is measured along. */
export type KasaneAxis = "block" | "inline";

export type KasaneOptions = {
  /** A selector for the elements that declare a surface. Default `"[data-surface]"`. */
  surfaces?: string;
  /**
   * The attribute kasane reads a surface's token from and copies onto the target. Default
   * `"data-surface"`. Point it at whatever your sections already carry.
   */
  attribute?: string;
  /** The axis a boundary is measured along. Default `"block"`, the direction a page scrolls. */
  axis?: KasaneAxis;
  /** Report where a boundary crosses a target. Default `true`. */
  split?: boolean;
  /**
   * The scroller the surfaces live in. Default the document's. Everything is measured relative to
   * this element's own box, so a panel, a modal or a horizontal strip works the same way the page
   * does, and a target pinned outside the scroller still resolves against what scrolls under it.
   */
  root?: Element | null;
};

export type Kasane = {
  /** The targets kasane writes on. */
  targets: HTMLElement[];
  /**
   * Measures the surfaces and the targets again, then writes. Call it after a layout change kasane
   * cannot see, such as content that arrived without changing any observed element's own box.
   */
  measure: () => void;
  /** Removes everything kasane wrote, and stops observing. */
  revert: () => void;
};

/** A box on the measured axis and across it, in whichever space its owner is stored in. */
type Box = { start: number; end: number; crossStart: number; crossEnd: number };

/** Which physical axis a logical one runs on, and whether it runs backwards along it. */
type Flow = { horizontal: boolean; flip: boolean };

/**
 * A surface, in document space, which scrolling does not change. `order` is its position in
 * document order, which is the order it paints in: a card inside a section comes after the section
 * and covers it, and so does a later sibling.
 */
type Surface = { token: string; order: number; box: Box };

/** What was last written on a target, so an unchanged frame writes nothing. */
type State = { token: string; start: string; end: string; split: string };

/** A target, in viewport space, which scrolling does not change for a fixed overlay. */
type Target = { element: HTMLElement; box: Box; written: State };

/** Enough precision for a clip edge, and coarse enough that sub-pixel jitter writes nothing. */
const SPLIT_PRECISION = 1e4;

/** Edges closer than this are one edge, since a browser's rects are fractional. */
const TOUCHING = 1;

/** A surface covering at least this much of a target across the axis counts as covering it all. */
const FULL_WIDTH = 0.995;

const NOTHING: State = { token: "", start: "", end: "", split: "" };

/** How much of the read phase a frame owes, in the order a larger amount subsumes a smaller one. */
const WRITE = 0;
const TARGETS = 1;
const SURFACES = 2;

const controllers = new WeakMap<Element, Kasane>();

const collect = (input: string | Element | Iterable<Element>): HTMLElement[] => {
  const list =
    typeof input === "string"
      ? document.querySelectorAll(input)
      : input instanceof Element
        ? [input]
        : input;

  return Array.from(list).filter((el): el is HTMLElement => el instanceof HTMLElement);
};

/**
 * Where a logical axis physically runs. `block` and `inline` are CSS's own axes: a page in Arabic
 * runs its inline axis right to left, and a page in vertical Japanese runs its block axis across
 * the page rather than down it. kasane reports the surface at the *start* of the axis and a
 * fraction measured from there, so the start has to be the one the writing direction means rather
 * than the left or top edge of a rect. One style read, in the read phase, where one is already paid
 * for.
 */
const flowOf = (element: Element, axis: KasaneAxis): Flow => {
  const style = getComputedStyle(element);
  const mode = style.writingMode;
  // Named rather than compared against `horizontal-tb`, so anything unexpected — a legacy value, a
  // keyword from after this was written — falls back to the way almost every page is laid out
  // instead of to the rarest one.
  const vertical = mode.startsWith("vertical") || mode.startsWith("sideways");

  // The block axis runs down the page, or across it in a vertical mode — leftwards in the `-rl`
  // ones. The inline axis runs the other way, reversed by `direction: rtl`; `sideways-lr` is the
  // one mode whose text climbs the page instead of descending it, which reverses it again.
  return axis === "block"
    ? { horizontal: vertical, flip: mode.endsWith("-rl") }
    : { horizontal: !vertical, flip: (style.direction === "rtl") !== (mode === "sideways-lr") };
};

/**
 * A rect along the measured axis and across it. Reading both off one `DOMRect` is what lets the
 * same arithmetic serve a horizontal boundary, so a half width section or a horizontal scroller
 * needs no second code path.
 *
 * An axis that runs backwards is measured in negated coordinates rather than given a code path of
 * its own: everything downstream only needs start to come before end, and negating both edges of
 * every box — and the scroll along with them — is exactly that. `scroll` arrives already negated
 * for such an axis, so what is stored stays a document-space number scrolling does not change.
 */
const boxOf = (
  rect: DOMRect,
  flow: Flow,
  origin: { x: number; y: number },
  scroll: number,
  crossScroll: number,
): Box => {
  const near = flow.horizontal ? rect.left - origin.x : rect.top - origin.y;
  const far = flow.horizontal ? rect.right - origin.x : rect.bottom - origin.y;
  const crossNear = flow.horizontal ? rect.top - origin.y : rect.left - origin.x;
  const crossFar = flow.horizontal ? rect.bottom - origin.y : rect.right - origin.x;

  return {
    start: (flow.flip ? -far : near) + scroll,
    end: (flow.flip ? -near : far) + scroll,
    crossStart: crossNear + crossScroll,
    crossEnd: crossFar + crossScroll,
  };
};

const span = (a: number, b: number, c: number, d: number) => Math.max(0, Math.min(b, d) - Math.max(a, c));

const same = (a: State, b: State) =>
  a.token === b.token && a.start === b.start && a.end === b.end && a.split === b.split;

export function kasane(
  target: string | Element | Iterable<Element>,
  options: KasaneOptions = {},
): Kasane {
  const selector = options.surfaces ?? "[data-surface]";
  const attribute = options.attribute ?? "data-surface";
  const axis: KasaneAxis = options.axis ?? "block";
  const reportSplit = options.split ?? true;
  const root = options.root ?? null;

  /**
   * Where the scroller's content starts, in viewport coordinates. Measuring both surfaces and
   * targets from here is what makes a scroll container need no second code path: the page scrolling
   * moves the scroller and everything in it by the same amount, so nothing relative to it changes.
   */
  const originOf = () => {
    if (!root) return { x: 0, y: 0 };
    const rect = root.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  };

  /**
   * The element whose writing direction the axis follows: the scroller, or the page's body when
   * that is the document. Body rather than the root element because `dir` is written on either and
   * inherits down, so the lower of the two is the one that has the answer both ways round.
   */
  const flowsFrom = () => root ?? document.body ?? document.documentElement;

  const scrollOf = () => {
    const down = root ? root.scrollTop : window.scrollY;
    const across = root ? root.scrollLeft : window.scrollX;
    const main = flow.horizontal ? across : down;
    return { main: flow.flip ? -main : main, cross: flow.horizontal ? down : across };
  };

  const elements = collect(target);

  // A target kasane already owns is released first. A second controller writing the same
  // attributes would leave whichever lost the race in charge of them.
  for (const element of elements) {
    controllers.get(element)?.revert();
  }

  const targets: Target[] = elements.map((element) => ({
    element,
    box: { start: 0, end: 0, crossStart: 0, crossEnd: 0 },
    written: NOTHING,
  }));

  let surfaces: Surface[] = [];
  let observed: Element[] = [];
  let flow = flowOf(flowsFrom(), axis);
  let frame = 0;
  let pending = WRITE;
  let live = true;

  const observer = new ResizeObserver(() => schedule(SURFACES));

  /**
   * Observing is its own step because re-observing on every read would feed the observer's own
   * callback back into a read, one per frame, forever. The set only changes when a surface is
   * added or removed, which is rare, so comparing it is cheaper than the loop it prevents.
   */
  const observe = (found: Element[]) => {
    const next = [root ?? document.documentElement, ...found, ...elements];
    if (next.length === observed.length && next.every((el, i) => observed[i] === el)) return;

    observer.disconnect();
    for (const element of next) observer.observe(element);
    observed = next;
  };

  /**
   * The targets, against the scroller's own box. One rect each, plus the scroller's, and nothing
   * else: a target is the only thing the page scrolling can move relative to the scroller, and
   * only when it is pinned outside it.
   */
  const readTargets = (from?: { x: number; y: number }) => {
    const origin = from ?? originOf();
    for (const entry of targets) {
      entry.box = boxOf(entry.element.getBoundingClientRect(), flow, origin, 0, 0);
    }
  };

  /**
   * The read phase. Surfaces are stored in document space and targets in viewport space, which is
   * the whole reason the write phase can run on a scroll without touching layout: only the offset
   * between the two spaces changed, and that is a number the browser already has.
   */
  const read = () => {
    // The writing direction is layout too: a `dir` toggled on the page moves the axis's start to
    // the other end of it, and every box measured after that has to agree on which end that is.
    flow = flowOf(flowsFrom(), axis);

    const { main: scroll, cross: crossScroll } = scrollOf();
    const origin = originOf();
    const found = Array.from((root ?? document).querySelectorAll(selector));

    surfaces = [];
    for (const element of found) {
      const token = element.getAttribute(attribute);
      if (!token) continue;
      surfaces.push({
        token,
        order: surfaces.length,
        box: boxOf(element.getBoundingClientRect(), flow, origin, scroll, crossScroll),
      });
    }

    readTargets(origin);
    observe(found);
  };

  /**
   * The write phase. A target is cut into bands at every surface edge that falls inside it, and
   * each band goes to the surface painted on top of that band, which is the last one in document
   * order covering it. Area alone would give a section that runs the whole way behind a target the
   * win over a card painted on top of half of it, and the card is what the eye sees.
   *
   * Bands also decide the split without a special case: a boundary exists when the target reads as
   * exactly two of them. A gap between two surfaces, a section shorter than the target, or a card
   * floating in the middle of one all read as three, which is the honest answer that there is no
   * single edge to clip on. Nothing here reads layout.
   */
  const write = () => {
    const { main: scroll, cross: crossScroll } = scrollOf();

    for (const entry of targets) {
      const { box } = entry;
      const extent = box.end - box.start;
      const crossExtent = box.crossEnd - box.crossStart;

      const behind: { token: string; order: number; start: number; end: number; weight: number }[] = [];

      if (extent > 0 && crossExtent > 0) {
        for (const surface of surfaces) {
          const start = surface.box.start - scroll;
          const end = surface.box.end - scroll;
          if (!span(box.start, box.end, start, end)) continue;

          const across = span(
            box.crossStart,
            box.crossEnd,
            surface.box.crossStart - crossScroll,
            surface.box.crossEnd - crossScroll,
          );
          if (!across) continue;

          behind.push({ token: surface.token, order: surface.order, start, end, weight: across / crossExtent });
        }
      }

      // Every edge inside the target, plus its own two, with anything within a pixel of the one
      // before it folded in: a rect is fractional, and two sections that meet do not always agree
      // on the fraction.
      const edges = [box.start];
      const candidates = [box.start, box.end];
      for (const surface of behind) {
        if (surface.start > box.start && surface.start < box.end) candidates.push(surface.start);
        if (surface.end > box.start && surface.end < box.end) candidates.push(surface.end);
      }
      candidates.sort((a, b) => a - b);

      for (const value of candidates) {
        if (value - (edges[edges.length - 1] as number) > TOUCHING) edges.push(value);
      }
      edges[edges.length - 1] = box.end;

      const runs: { token: string | null; from: number }[] = [];
      const areas = new Map<string, number>();

      for (let index = 0; index < edges.length - 1; index += 1) {
        const from = edges[index] as number;
        const to = edges[index + 1] as number;
        const middle = (from + to) / 2;

        const covering: typeof behind = [];
        let owner: (typeof behind)[number] | null = null;
        for (const surface of behind) {
          if (surface.start > middle || middle >= surface.end) continue;
          covering.push(surface);
          if (!owner || surface.order > owner.order) owner = surface;
        }

        // The surface on top of a band takes as much of it as it covers across the axis, and what
        // it leaves goes to the one under it. A panel over the right half of a band leaves the
        // left half to the section behind it, which is what the eye sees and what a single point
        // sampled anywhere in the band cannot tell you.
        let claimed = 0;
        for (const surface of covering.sort((a, b) => b.order - a.order)) {
          const take = Math.min(surface.weight, 1 - claimed);
          if (take <= 0) break;
          areas.set(surface.token, (areas.get(surface.token) ?? 0) + (to - from) * take);
          claimed += take;
        }

        const token = owner?.token ?? null;
        if (runs[runs.length - 1]?.token !== token) runs.push({ token, from });
      }

      let dominant = "";
      let best = 0;
      for (const [token, area] of areas) {
        if (area > best) {
          best = area;
          dominant = token;
        }
      }

      let state: State = NOTHING;

      if (dominant) {
        state = { token: dominant, start: "", end: "", split: "" };

        // An edge is only one straight line when every surface behind the target runs the whole
        // way across it. A panel covering half the width puts a corner through the target instead,
        // and a clip on one fraction would paint half of it the wrong colour.
        const straight = behind.every((surface) => surface.weight >= FULL_WIDTH);

        const [above, below] = runs;
        if (reportSplit && straight && runs.length === 2 && above?.token && below?.token) {
          const fraction = Math.min(1, Math.max(0, (below.from - box.start) / extent));

          state = {
            token: dominant,
            start: above.token,
            end: below.token,
            split: String(Math.round(fraction * SPLIT_PRECISION) / SPLIT_PRECISION),
          };
        }
      }

      if (same(state, entry.written)) continue;
      entry.written = state;

      const { element } = entry;
      const style = element.style;

      if (state.token) element.setAttribute("data-kasane", state.token);
      else element.removeAttribute("data-kasane");

      if (state.split) {
        element.setAttribute("data-kasane-start", state.start);
        element.setAttribute("data-kasane-end", state.end);
        element.setAttribute("data-kasane-axis", axis);
        style.setProperty("--kasane-split", state.split);
      } else {
        element.removeAttribute("data-kasane-start");
        element.removeAttribute("data-kasane-end");
        element.removeAttribute("data-kasane-axis");
        style.removeProperty("--kasane-split");
      }
    }
  };

  /**
   * Three amounts of work, and a frame does the largest one asked of it. The scroller's own scroll
   * changes the offset between the two spaces and nothing else, so it writes without reading. The
   * page scrolling under a scroller can only move a target that is pinned outside it, so it reads
   * the targets and leaves the surfaces alone: they are stored against the scroller, which the
   * page carried along with them. Only a layout change reads everything.
   */
  function schedule(work: number) {
    if (!live) return;
    if (work > pending) pending = work;
    if (frame) return;

    frame = requestAnimationFrame(() => {
      frame = 0;
      const due = pending;
      pending = WRITE;

      if (due === SURFACES) read();
      else if (due === TARGETS) readTargets();

      write();
    });
  }

  const onScroll = () => schedule(WRITE);
  const onResize = () => schedule(SURFACES);

  read();
  write();

  const scroller: Element | Window = root ?? window;
  scroller.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);

  // A scroller inside the page still moves with the page, and a target pinned outside it does not,
  // so the document's scroll matters even when the surfaces are in a box of their own. It cannot
  // move a surface relative to the scroller, though, so it costs the targets and no more.
  const onPageScroll = () => schedule(TARGETS);
  if (root) window.addEventListener("scroll", onPageScroll, { passive: true });

  // Web fonts land after the first paint and move everything below them. The promise settles once,
  // and a browser without it simply never queues this read.
  document.fonts?.ready.then(() => schedule(SURFACES));

  const controller: Kasane = {
    targets: elements,

    measure: () => {
      if (!live) return;
      read();
      write();
    },

    revert: () => {
      if (!live) return;
      live = false;

      cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      if (root) window.removeEventListener("scroll", onPageScroll);

      for (const entry of targets) {
        const { element } = entry;
        element.removeAttribute("data-kasane");
        element.removeAttribute("data-kasane-start");
        element.removeAttribute("data-kasane-end");
        element.removeAttribute("data-kasane-axis");
        element.style.removeProperty("--kasane-split");
        controllers.delete(element);
      }

      surfaces = [];
      observed = [];
    },
  };

  for (const element of elements) {
    controllers.set(element, controller);
  }

  return controller;
}
