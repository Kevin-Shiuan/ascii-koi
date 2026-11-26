import { flipH, flipV, GLIDER, LWSS, type KoiKind, type Life } from "../src";
import { loop, mountFigures, ramp, type Figure } from "./figures";
import { flag } from "./query";

const still = flag("still") || matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Gliders from the corners, a spaceship each way, and a soup in the middle that settles to ash. */
const seed = (life: Life) => {
  const { cols, rows } = life;
  life.put(GLIDER, 2, 2);
  life.put(flipH(GLIDER), cols - 6, Math.floor(rows * 0.15));
  life.put(flipV(GLIDER), Math.floor(cols * 0.2), rows - 6);
  life.put(flipH(flipV(GLIDER)), cols - 10, rows - 8);
  life.put(LWSS, cols - 8, Math.floor(rows * 0.5));
  life.put(flipH(LWSS), 2, Math.floor(rows * 0.72));
  life.soup(cols * 0.36, rows * 0.3, cols * 0.64, rows * 0.7, 0.32);
};

const KINDS: KoiKind[] = [
  "kohaku",
  "tancho",
  "sanke",
  "showa",
  "utsuri",
  "ogon",
  "platinum",
  "kigoi",
  "chagoi",
  "asagi",
  "shusui",
];

/** One koi on its own, no food, so the anatomy plates hold still enough to read. */
const koi = (extra: Partial<Figure> = {}): Figure => ({
  koi: [{ kind: "kohaku", size: 1.4 }],
  fish: 0,
  pointer: false,
  clearCentre: false,
  feed: false,
  still,
  ...extra,
});

const engines = mountFigures({
  life: { koi: [], fish: 0, pointer: false, still, life: seed },
  field: { koi: [], fish: 0, draw: true, drip: true, still },
  agents: { koi: [], still },
  spine: koi({ stage: "spine" }),
  silhouette: koi({ stage: "silhouette" }),
  shaded: koi({ stage: "shaded" }),
  glyphs: koi(),
  ...Object.fromEntries(KINDS.map((kind) => [`species-${kind}`, koi({ koi: [{ kind, size: 1.25 }] })])),
  feeding: { koi: [{ kind: "kohaku", size: 1.1 }, { kind: "showa", size: 0.9 }], clearCentre: false, feed: false, still },
  bleed: koi({
    koi: [
      { kind: "kohaku", size: 1.1 },
      { kind: "showa", size: 0.9 },
    ],
    life: seed,
  }),
});

if (!still) {
  // Fig. 09: a pinch of food somewhere every few seconds, more often than the keeper would,
  // and only while the last pinch is mostly gone, so pellets never pile up off-screen.
  {
    const { world } = engines.feeding;
    setInterval(() => {
      if (world.pellets.filter((p) => p.alive).length > 2) return;
      world.scatter(world.width * (0.2 + 0.6 * Math.random()), world.height * (0.2 + 0.6 * Math.random()), 3 + Math.floor(Math.random() * 3));
    }, 4000);
  }

  // Fig. 01: Life alone. Gliders leave, the soup settles, then the board fades and starts again.
  {
    const { renderer } = engines.life;
    const life = renderer.life!;
    let reseeded = true;
    loop(30, (t) => {
      renderer.lifeOpacity = t < 27 ? ramp(t, 0, 1.5) : 1 - ramp(t, 27, 29.5);
      if (t < 27) reseeded = false;
      else if (t >= 29.5 && !reseeded) {
        life.reset();
        reseeded = true;
      }
    });
  }

  // Fig. 10: Life first, then the koi bleed in.
  //   0–12s  Life alone.  12–16s  koi fade in, the wake starts seeding cells.
  //  16–30s  koi swim through the ash; seeding stops at 24s.  30–36s  fade, reseed, again.
  {
    const { renderer } = engines.bleed;
    const life = renderer.life!;
    const tag = document.querySelector<HTMLElement>('[data-tag="bleed"]')!;
    let phase = "";
    const show = (label: string) => {
      if (label === phase) return;
      phase = label;
      tag.textContent = label;
    };
    renderer.koiOpacity = 0;
    let reseeded = true;
    loop(36, (t) => {
      if (t < 12) {
        renderer.koiOpacity = 0;
        renderer.lifeOpacity = ramp(t, 0, 1.5);
        life.sowing = false;
        show("Fig. 10 · Life · B3/S23");
      } else if (t < 30) {
        renderer.koiOpacity = ramp(t, 12, 15);
        renderer.lifeOpacity = 1;
        life.sowing = t < 24;
        show(t < 20 ? "Fig. 10 · Bleed · wake seeds cells" : "Fig. 10 · Koi · bodies clear cells");
        reseeded = false;
      } else {
        renderer.koiOpacity = 1 - ramp(t, 30, 33);
        renderer.lifeOpacity = 1 - ramp(t, 32, 35);
        life.sowing = false;
        if (t >= 35 && !reseeded) {
          life.reset();
          reseeded = true;
        }
      }
    });
  }
}
