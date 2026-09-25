# Component and motion parity

Read this before rebuilding a component that has **more than one trigger**:
several states, directed transitions between them, content that leaves while
other content enters, a container that morphs its size, or timers of its own —
and whenever a user asks for such a component "1:1" or as a framework port.

One element with one trigger does not need this. `extract` → `rebuild` covers

## Why a faithful static copy still feels wrong

A DOM snapshot is one frame. It does not contain the component state, element
keys, presence behaviour, spring parameters, timers, cleanup, layout
measurement or the providers the component depends on. Two reconstructions can
match every screenshot at rest and still differ in everything that happens
between two screenshots. Rebuild the state machine and the motion model that
produce the frames, then measure original and rebuild along the same timeline.

## Pick the path, and say which one you took

1. **Runtime slice** — the owning module and its smallest working dependency
   closure, run as it was shipped. Most faithful, least editable.
2. **Framework port** — the recovered logic in the requested framework, with
   the same motion library, keys, timing and assets.
3. **Behavioural reimplementation** — Label every value that was estimated
   instead of recovered.

Do not present a hand-tuned imitation as source-identical.

## 1. Fix the observable contract

Before analysing, write down what has to survive: target component and route,
requested output (React source, single HTML, Web Component …), viewport,
device scale, theme, reduced-motion setting, every user action, every
autonomous behaviour, and which surrounding controls are test harness rather
than component. Unless the user narrows it, the scope is every publicly
reachable state — not only the first view.

## 2. Find the owning code

Start with `parity extract <url> --selector <root>`. It reports listeners,
observers, rAF activity, engine animations and libraries — a map, not the
answer.

Locate the owning module through anchors that survive minification: visible
text, ARIA labels, unique SVG path data, exact dimensions, colour values, state
names, timer constants, export names. For Webpack/Next chunks follow module ids
and exports; for Vite/Rollup follow symbols and dynamic imports. Save an
untouched copy of every bundle before patching or slicing it.

The result is a dependency closure: component, child components, motion
runtime, icons, fonts, styles, assets, and only the providers it truly needs.

## 3. State matrix

Search the code for view arrays, `switch` blocks, variant maps and delayed
`setState` calls; a row of buttons is often a state inventory. Then open every
state in the original and confirm it.

| State | Entry | Exit → target | Geometry at rest | Content | Local state | Autonomous | Cleanup |
|---|---|---|---|---|---|---|---|

Geometry means width, height, radius, padding, overflow. Autonomous means
timers, intervals, random values, media time. Cleanup is what stops when the
state is left.

## 4. Transition matrix

| From | To | Trigger | Delay | Motion (spring / duration + easing) | Persistent element | Key / presence | Overlap |
|---|---|---|---|---|---|---|---|

Include transitions nobody clicks: a state that advances after a timeout, a
counter that ticks, progress that runs on its own. Parameters often differ per
transition — one global value rarely matches every path.

## 5. Visual inputs

Measure each state at rest: bounding boxes, loaded font file, weight, size,
line height, letter spacing, `font-variant-numeric`, colours, borders,
shadows, filters, backdrop filters, gradients, gaps, offsets, transform
origin, SVG `viewBox`/paths/stroke, image crop and object position.

Fonts and SVG geometry are motion inputs: a different font changes text width,
which changes the layout animation; a similar icon moves the perceived centre
of rotation.

## 6. Motion model

Recover from code and runtime: library and API; spring stiffness, damping,
mass, bounce, visual duration, rest thresholds; easing, delay, stagger,
repeat; layout/FLIP animation and shared layout ids; presence mode and keys;
initial/animate/exit values for transform, opacity, blur, clip path, path
length; MotionValues and pointer or scroll mappings.

Keep the origin of every value, as `extract` does:

| Origin | Meaning |
|---|---|
| recovered | read from the shipped code — exact |
| engine | from `getAnimations()` — exact |
| sampled | from a frame timeline |
| estimated | tuned by eye — must be labelled as such in the result |

A recovered spring is not replaced by an approximate CSS transition. Keyed
presence is not simulated with `innerHTML`. A wrapper the original keeps alive
is not remounted.

## 7. Rebuild semantics, not markup

Keep the persistent container persistent and switch state content inside it.
Use the same key boundaries so outgoing and incoming content overlap exactly
when the original lets them. Bind timers, listeners and intervals to the
component lifecycle and end them on unmount. Choose the smallest technology
that expresses the recovered model without simplification — the target
technology follows from the evidence, not from the last case. Bundle into a
single file only after the editable source works.

## 8. Counter-measure along the same timeline

Write one steps module and run it against both sides, same viewport:

```bash
parity interact <TARGET-URL>           capture/orig  --steps component-steps.mjs
parity interact http://localhost:4173/ capture/clone --steps component-steps.mjs
```

- **CSS transitions, keyframes, WAAPI** — seek them. Exact on both sides.
- **JS-driven motion** (springs and tweens on rAF) — sample a timeline and
  compare its shape.

Both helpers, for the steps module:

```js
// Frame-sampled, action-relative timeline of one element.
const timeline = async (page, sel, act, { ms = 1200, on = 'pointerdown', props = ['transform', 'opacity', 'filter', 'border-radius'] } = {}) => {
  await page.evaluate(({ sel, ms, on, props }) => {
    const tl = window.__tl = { t0: null, rows: [], done: false };
    const mark = () => { tl.t0 ??= performance.now(); };
    if (on) addEventListener(on, mark, { capture: true, once: true }); else mark();
    const first = document.querySelector(sel);
    const tick = now => {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect(), c = getComputedStyle(el);
        tl.rows.push({ t: now, x: r.x, y: r.y, w: r.width, h: r.height, same: el === first,
          kids: el.children.length, text: el.innerText.slice(0, 40),
          ...Object.fromEntries(props.map(p => [p, c.getPropertyValue(p)])) });
      }
      if (tl.t0 === null || now - tl.t0 < ms) requestAnimationFrame(tick); else tl.done = true;
    };
    requestAnimationFrame(tick);
  }, { sel, ms, on, props });
  await act();
  await page.waitForFunction(() => window.__tl.done, null, { timeout: ms + 10000 });
  return page.evaluate(() => {
    const { t0, rows } = window.__tl;
    const r1 = n => Math.round(n * 10) / 10;
    const out = rows.filter(r => r.t >= t0 - 17).map(r => ({ ...r, t: Math.round(r.t - t0), x: r1(r.x), y: r1(r.y), w: r1(r.w), h: r1(r.h) }));
    const a = out[0], z = out.at(-1);
    const off = r => Math.abs(r.w - z.w) > 0.5 || Math.abs(r.h - z.h) > 0.5
      || r.transform !== z.transform || r.opacity !== z.opacity || r.filter !== z.filter;
    const last = out.findLastIndex(off);
    const over = k => r1(z[k] >= a[k] ? Math.max(...out.map(r => r[k])) - z[k] : z[k] - Math.min(...out.map(r => r[k])));
    return {
      summary: {
        from: { w: a.w, h: a.h, text: a.text }, to: { w: z.w, h: z.h, text: z.text },
        overshoot: { w: over('w'), h: over('h') },
        settleMs: last < 0 ? 0 : out[Math.min(last + 1, out.length - 1)].t,
        wrapperKept: out.every(r => r.same), maxChildren: Math.max(...out.map(r => r.kids)),
      },
      rows: out,
    };
  });
};

// CSS transitions, keyframes and WAAPI: engine-exact frames by seeking.
const seek = (page, sel, t) => page.evaluate(({ sel, t }) => {
  for (const a of document.querySelector(sel).getAnimations({ subtree: true })) { a.pause(); a.currentTime = t; }
}, { sel, t });

export default async ({ page, step, shot }) => {
  await step('idle → timer', async () =>
    (await timeline(page, '.island', () => page.click('[data-view="timer"]'), { ms: 1200 })).summary);
};
```

`on` is the event that starts the clock: `pointerdown` for clicks,
`pointerover` for hover, `keydown` for keys, `null` for a transition that
starts by itself (call it right after entering the previous state). `ms`
comes from the transition's own duration plus its settle. `wrapperKept` tells
whether the container survived the transition; `maxChildren` shows whether
outgoing and incoming content overlapped. Check `getAnimations()` first even
on JS-animated components — motion libraries hand some properties to WAAPI,
and whatever appears there can be seeked exactly.

**Tolerances.** At rest: identical text and state, geometry within one CSS
pixel. In motion: same `from`/`to`, same order of sub-animations, overshoot
and settle within about one frame, same `wrapperKept` and `maxChildren`.

Random or live content — audio bars, particles, clocks, video — is compared by
invariants: element count, value range, cadence, colour, dimensions, response
to pause and reset. Seed randomness only if it is seeded identically on both
sides.

## 9. Ledger

One row per state and per transition. A reachable state or transition without
a row is untested.

| State / transition | Trigger | Rest geometry | Font / assets | Motion (summary) | Interaction | Result |
|---|---|---|---|---|---|---|

## Worked example: Dynamic Island

A case, not a template. A static HTML copy of this component looked right and
felt wrong; the causes were all invisible in a screenshot:

| Found in this case | General question it answers |
|---|---|
| one black wrapper kept alive, size animated by layout measurement | where is the continuity boundary, and which engine owns the geometry? |
| state content keyed separately, presence with `popLayout`, entry via scale/opacity/blur | what is the lifetime of old and new content, and do they overlap? |
| a different spring bounce per transition pair | are motion parameters per transition or global? |
| timer digits in fixed 16 px slots, keyed by digit and position, `tabular-nums` | which typographic and geometric invariants hold? |
| intervals and delays ended in effect cleanup | which temporal resources belong to the lifecycle? |

The next target asks the same questions and may answer every one differently —
a CSS keyframe block, a GSAP timeline, a Rive state machine. React was the
right target here because the recovered model was React plus a motion
library, not because React is smoother.

## Failure patterns

| Symptom | Cause |
|---|---|
| looks right stopped, wrong in motion | timing model, key boundary or transform origin guessed |
| container snaps, then content animates | wrapper remounted or layout animation missing |
| digits jitter or slide sideways | font metrics, tabular numerals, slot width or per-digit keys differ |
| gets choppier the longer it runs | intervals or listeners survive unmount |
| pixel diff fails on live content | compare invariants, not pixels |
| runtime slice works in place, fails isolated | an implicit provider, CSS variable, font, base path or module was left out |

## Done when

- every reachable state and transition has a ledger row
- rest geometry within one CSS pixel, text identical, fonts and assets identical
- motion parameters recovered, or every estimated one labelled
- transitions measured on both sides with the same steps module and within tolerance
- timers, pause, reset and cleanup behave the same
- no unexplained console errors
- editable source exists alongside any bundled artifact

Report separately what was reused, what was ported, what was reimplemented,
which states and transitions were verified, and what remains different. Say
"1:1" only when the ledger is complete and the timeline measurement supports it.
