/**
 * Draws the World as a grid of ASCII cells:
 *   1. a cell grid on a dark pond, or graphite on paper
 *   2. a wake field that diffuses where things swim, lighting the dots pale teal
 *   3. fish as minimal ASCII dashes, one per cell, glinting on hard turns
 *   4. koi rasterised cell-by-cell with supersampled edges: coloured blocks
 *      in each variety's pattern, shaded by the light, with glyph texture on
 *      top, and translucent fins whose rays are drawn as line glyphs
 *   5. food pellets floating over everything
 */
import type { Life } from "./life";
import { clamp, hash3, smoothstep } from "./math";
import { KOI_NODES, PELLET_LIFE, type Koi, type KoiKind, type World } from "./world";

const ALPHA_LEVELS = 6;
const FISH_ALPHAS = [0.28, 0.42, 0.58, 0.74, 0.9];

// Dot colour classes: blue, green, red, pale; the last entry is the wake.
const DOT_RGB: [number, number, number][] = [
  [48, 52, 235],
  [52, 205, 60],
  [228, 50, 44],
  [190, 212, 255],
  [120, 215, 205],
];
const DOT_BASE_ALPHA = [1, 1, 1, 1, 1];
const WAKE = DOT_RGB.length - 1;

export type Theme = "dark" | "light";
/** How much of each koi to build. The blueprint pages step through these. */
export type Stage = "spine" | "silhouette" | "shaded" | "full";

type RGB = [number, number, number];

// Koi colours, by index. The pattern functions below pick among these.
const WHITE = 0;
const RED = 1;
const BLACK = 2;
const GOLD = 3;
const PLATINUM = 4;
const YELLOW = 5;
const BROWN = 6;
const BLUE = 7;
const ORANGE = 8;
const SLATE = 9;

interface Palette {
  bg: string;
  grid: string;
  fish: RGB;
  wake: RGB;
  wakeAlpha: number;
  heatHot: RGB;
  heatCool: RGB;
  /** Koi colours by index, as they look on this stage. */
  koi: RGB[];
  /** Outline glyphs: tinted from the koi on the dark pond, plain ink on paper. */
  edge: (rgb: RGB, level: number) => string;
  eye: string;
  /** The bright fleck in a metallic koi's shimmer. */
  glint: string;
  pellet: RGB;
  /** Flat tone for the silhouette stage. */
  flat: string;
  /** Hairline and markers for the spine stage. */
  line: string;
}

const rgb = (c: RGB, k: number, a = 1) => {
  const r = Math.min(255, Math.round(c[0] * k));
  const g = Math.min(255, Math.round(c[1] * k));
  const b = Math.min(255, Math.round(c[2] * k));
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a.toFixed(2)})`;
};

const PALETTES: Record<Theme, Palette> = {
  dark: {
    bg: "#02080a",
    grid: "rgba(170,230,225,0.05)",
    fish: [222, 238, 232],
    wake: [120, 215, 205],
    wakeAlpha: 1,
    heatHot: [255, 222, 160],
    heatCool: [200, 170, 120],
    koi: [
      [238, 234, 226], // white
      [226, 70, 34], // hi, the red
      [60, 60, 68], // sumi, the black
      [236, 174, 54], // gold
      [222, 228, 232], // platinum
      [232, 206, 78], // yellow
      [150, 102, 60], // brown
      [112, 142, 170], // asagi blue
      [232, 118, 48], // orange
      [58, 80, 110], // slate
    ],
    edge: (c, level) => rgb(c, level * 0.62),
    eye: "#d8dde4",
    glint: "#fff8e6",
    pellet: [204, 156, 96],
    flat: "rgb(150,150,150)",
    line: "rgba(235,230,219,0.75)",
  },
  // Paper: the same koi, a touch muted, and outlines in graphite so a white koi still reads.
  light: {
    bg: "#f7f6f3",
    grid: "rgba(35,35,35,0.08)",
    fish: [35, 35, 35],
    wake: [35, 35, 35],
    wakeAlpha: 0.45,
    heatHot: [35, 35, 35],
    heatCool: [35, 35, 35],
    koi: [
      [226, 222, 212],
      [214, 72, 40],
      [44, 44, 48],
      [222, 164, 56],
      [208, 212, 216],
      [220, 194, 74],
      [146, 100, 60],
      [108, 136, 162],
      [222, 116, 52],
      [62, 82, 110],
    ],
    edge: (_c, level) => `rgba(35,35,35,${(0.35 + 0.45 * Math.min(1, level)).toFixed(2)})`,
    eye: "#f7f6f3",
    glint: "#ffffff",
    pellet: [140, 100, 54],
    flat: "rgb(120,120,120)",
    line: "rgba(35,35,35,0.75)",
  },
};

// Sparse glyphs on bright skin, dense glyphs in shadow, so the texture
// reinforces the shading instead of fighting it.
const SKIN_RAMP = ".:;=+x*%#";
/** Where the reticulated net of scales shows. */
const NET_GLYPHS = "x+";
const DORSAL_GLYPHS = "!|";
const EDGE_HEAVY = ":;";
const EDGE_LIGHT = ".',`";
/** Fin rays, by screen direction: across, down-right, down, down-left. */
const RAY_GLYPHS = "-\\|/";

const FLAG_BODY = 1;
const FLAG_EDGE = 2;
const FLAG_FIN = 3;
const FLAG_DORSAL = 4;
const FLAG_EYE = 5;
/** A body cell on the reticulated net between scales. */
const FLAG_NET = 6;
/** A metallic koi's shimmer catching the light. */
const FLAG_GLINT = 7;

// Sub-cell sample offsets for anti-aliased silhouettes.
const SUBSAMPLES = [0.25, 0.3, 0.75, 0.3, 0.25, 0.72, 0.75, 0.72];

/**
 * A koi from above, half-width at s ∈ [0, 1] (snout → tail tip) as a fraction of length: a blunt rounded
 * head, the body full through the shoulders, tapering to a narrow tail stalk. The tail fin takes over at 0.8.
 */
function koiHalfWidth(s: number) {
  if (s < 0) return 0;
  if (s < 0.11) return 0.104 * Math.pow(Math.sin(((s / 0.11) * Math.PI) / 2), 0.55);
  if (s < 0.3) return 0.104 + 0.022 * smoothstep(0.11, 0.3, s);
  if (s < 0.8) return 0.026 + 0.1 * Math.pow(1 - smoothstep(0.3, 0.84, s), 0.85);
  if (s < 0.86) return 0.026 * (1 - 0.4 * smoothstep(0.8, 0.86, s));
  return 0;
}

/** One patch of colour on the back, in body coordinates: s along, v across (−1 one flank → 1 the other). */
interface Patch {
  c: number;
  s: number;
  v: number;
  rs: number;
  rv: number;
  /** How ragged the edge is; 0 is a clean ellipse (the tancho's circle). */
  wob: number;
  seed: number;
}

/** A variety's look: base colour, patches over it, and the rules for head, flanks and fins. */
interface Look {
  base: number;
  patches: Patch[];
  /** A pale head, as on asagi and shusui. */
  head?: number;
  /** Colour up the flanks beyond `sidesFrom` across. */
  sides?: number;
  sidesFrom?: number;
  fin: number;
  /** Colour at the root of the pectorals (showa's black, asagi's orange). */
  finRoot?: number;
  /** Black stripes across the pectorals (sanke). */
  finStripes?: boolean;
  /** How strongly the net between scales shows; 0 for none. */
  net: number;
  /** Scaleless, with one row of big scales down the back. */
  doitsu?: boolean;
  metallic?: boolean;
}

/** Per-load salt, so every visit gets its own koi. */
const SALT = Math.floor(Math.random() * 100000);

function inPatch(s: number, v: number, p: Patch) {
  const ds = (s - p.s) / p.rs;
  const dv = (v - p.v) / p.rv;
  const d2 = ds * ds + dv * dv;
  if (d2 > 1.6) return false;
  const angle = Math.atan2(dv, ds);
  const r = 1 + p.wob * (Math.sin(angle * 3 + p.seed * 6.3) * 0.6 + Math.sin(angle * 5 + p.seed * 11.7) * 0.4);
  return d2 < r * r;
}

/** Build one koi's look. Deterministic per koi id and page load. */
function makeLook(kind: KoiKind, id: number): Look {
  let n = 0;
  const rnd = () => hash3(id * 131 + SALT, n++, 977);
  const r = (lo: number, hi: number) => lo + rnd() * (hi - lo);

  /** Patches spread down the back from s0 to s1, with gaps between them. */
  const run = (c: number, count: number, s0: number, s1: number, size: number, rv: [number, number], vSpread: number) => {
    const out: Patch[] = [];
    const seg = (s1 - s0) / count;
    for (let i = 0; i < count; i++) {
      out.push({
        c,
        s: s0 + (i + 0.5) * seg + r(-0.15, 0.15) * seg,
        v: r(-vSpread, vSpread),
        rs: seg * size * r(0.8, 1.1),
        rv: r(rv[0], rv[1]),
        wob: r(0.1, 0.22),
        seed: rnd(),
      });
    }
    return out;
  };
  /** The red cap over the head, stopping short of the nose. */
  const headHi = (c: number): Patch => ({ c, s: r(0.08, 0.1), v: r(-0.15, 0.15), rs: r(0.045, 0.06), rv: r(0.9, 1.3), wob: 0.12, seed: rnd() });
  const reds = () => [headHi(RED), ...run(RED, rnd() < 0.7 ? 2 : 3, 0.2, 0.76, 0.56, [0.7, 1.3], 0.45)];

  switch (kind) {
    case "kohaku":
      return { base: WHITE, patches: reds(), fin: WHITE, net: 0.08 };
    case "tancho":
      return { base: WHITE, patches: [{ c: RED, s: 0.082, v: 0, rs: 0.04, rv: 0.52, wob: 0, seed: 0 }], fin: WHITE, net: 0.08 };
    case "sanke":
      return {
        base: WHITE,
        patches: [...reds(), ...run(BLACK, Math.round(r(3, 5)), 0.26, 0.78, 0.22, [0.22, 0.4], 0.7)],
        fin: WHITE,
        finStripes: true,
        net: 0.08,
      };
    case "showa":
      return {
        base: BLACK,
        patches: [...run(WHITE, 3, 0.2, 0.8, 0.4, [0.6, 1], 0.5), ...reds()],
        fin: WHITE,
        finRoot: BLACK,
        net: 0.06,
      };
    case "utsuri":
      return {
        base: BLACK,
        patches: [{ ...headHi(WHITE), v: r(-0.4, 0.4) }, ...run(WHITE, 3, 0.2, 0.8, 0.48, [0.7, 1.1], 0.5)],
        fin: WHITE,
        finRoot: BLACK,
        net: 0.06,
      };
    case "ogon":
      return { base: GOLD, patches: [], fin: GOLD, net: 0.12, metallic: true };
    case "platinum":
      return { base: PLATINUM, patches: [], fin: PLATINUM, net: 0.12, metallic: true };
    case "kigoi":
      return { base: YELLOW, patches: [], fin: YELLOW, net: 0.1 };
    case "chagoi":
      return { base: BROWN, patches: [], fin: BROWN, net: 0.3 };
    case "asagi":
      return { base: BLUE, patches: [], head: WHITE, sides: ORANGE, sidesFrom: 0.72, fin: WHITE, finRoot: ORANGE, net: 0.34 };
    case "shusui":
      return { base: BLUE, patches: [], head: WHITE, sides: ORANGE, sidesFrom: 0.55, fin: WHITE, finRoot: ORANGE, net: 0, doitsu: true };
  }
}

/** Visible dark-grey cell grid, snapped to device pixels. Shared with the sidebar backdrop. */
export function paintGrid(
  g: CanvasRenderingContext2D, W: number, H: number, cw: number, ch: number, dpr: number,
  stroke = "rgba(255,255,255,0.055)",
) {
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.strokeStyle = stroke;
  g.lineWidth = 1;
  g.beginPath();
  for (let c = 0; c <= Math.ceil(W / cw); c++) {
    const x = Math.round(c * cw * dpr) + 0.5;
    g.moveTo(x, 0);
    g.lineTo(x, H * dpr);
  }
  for (let r = 0; r <= Math.ceil(H / ch); r++) {
    const y = Math.round(r * ch * dpr) + 0.5;
    g.moveTo(0, y);
    g.lineTo(W * dpr, y);
  }
  g.stroke();
}

export class AsciiRenderer {
  private ctx: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement;
  private dpr = 1;
  private width = 0;
  private height = 0;
  private cw = 12;
  private ch = 18;
  private cols = 0;
  private rows = 0;
  private fontFamily = "ui-monospace, Menlo, monospace";
  private palette: Palette = PALETTES.dark;
  /** How much of each koi to draw. */
  stage: Stage = "full";
  /** Fade for the koi; at 0 they are neither drawn nor rasterised. */
  koiOpacity = 1;
  /** A Game of Life on the same cells, drawn under the fish. Set before the first resize. */
  life: Life | null = null;
  lifeOpacity = 1;

  private dotKind = new Uint8Array(0); // 0 none, 1 blue, 2 green, 3 red, 4 pale
  private dotPhase = new Float32Array(0);
  private dotFreq = new Float32Array(0);
  private energy = new Float32Array(0);
  private energyTmp = new Float32Array(0);
  private heat = new Float32Array(0);
  private bucketOf = new Uint8Array(0);
  private bucketOrder = new Int32Array(0);
  private bucketCounts = new Int32Array(DOT_RGB.length * ALPHA_LEVELS + 1);
  private dotStyles: string[] = [];

  private koiFlag = new Uint8Array(0);
  private koiShade = new Float32Array(0);
  private koiKey = new Uint32Array(0);
  private koiDepth = new Float32Array(0);
  private koiColor = new Uint8Array(0);
  /** Fin cells: which way the ray runs on screen, as an index into RAY_GLYPHS. */
  private koiRay = new Uint8Array(0);
  /** Cells darkened by a koi's shadow on the pond floor. */
  private koiShadow = new Uint8Array(0);
  private spine = new Float32Array(KOI_NODES * 2);
  private arc = new Float32Array(KOI_NODES);
  private arcTotal = 1;
  private looks = new Map<string, Look>();
  private look!: Look;
  private koiId = 0;
  private time = 0;
  // Fin pose for the koi being rasterised: pectoral sweep each side, tail lobe spread, and fin sizes.
  private pecSweepLeft = 0;
  private pecSweepRight = 0;
  private tailSpread = 0;
  private longFins = false;
  // Scratch outputs of sampleKoi(), to avoid allocating per sample.
  private hitFlag = 0;
  private hitShade = 0;
  private hitColor = 0;
  private hitRay = 0;
  private hitS = 0;
  private hitV = 0;
  private hitDist = 0;

  /** Cells holding a fish this frame (frame stamp); dots skip them. */
  private fishStamp = new Uint32Array(0);
  private frameId = 0;
  /** Fish cells bucketed by brightness, so each bucket is one fillStyle. */
  private fishBuckets: number[][] = FISH_ALPHAS.map(() => []);
  private fishStyles: string[] = [];

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.bg = document.createElement("canvas");
    this.setTheme("dark");
  }

  /** Dark pond (the default) or paper (graphite on off-white). */
  setTheme(theme: Theme) {
    const p = (this.palette = PALETTES[theme]);
    this.dotStyles = [];
    for (let c = 0; c < DOT_RGB.length; c++) {
      const [r, g, b] = c === WAKE ? p.wake : DOT_RGB[c];
      const base = c === WAKE ? p.wakeAlpha : DOT_BASE_ALPHA[c];
      for (let l = 0; l < ALPHA_LEVELS; l++) {
        const a = (base * (l + 1)) / ALPHA_LEVELS;
        this.dotStyles.push(`rgba(${r},${g},${b},${a.toFixed(3)})`);
      }
    }
    const [fr, fg, fb] = p.fish;
    this.fishStyles = FISH_ALPHAS.map((a) => `rgba(${fr},${fg},${fb},${a})`);
    if (this.cols > 0) this.paintBackground();
  }

  get cellWidth() {
    return this.cw;
  }

  get cellHeight() {
    return this.ch;
  }

  setFontFamily(family: string) {
    if (family) this.fontFamily = family;
  }

  resize(width: number, height: number, dpr: number) {
    const prevCols = this.cols;
    const prevRows = this.rows;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.cw = clamp(Math.round(width / 124), 8, 13);
    this.ch = Math.round(this.cw * 1.45);
    this.cols = Math.ceil(width / this.cw);
    this.rows = Math.ceil(height / this.ch);

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.bg.width = this.canvas.width;
    this.bg.height = this.canvas.height;

    const n = this.cols * this.rows;
    if (this.cols !== prevCols || this.rows !== prevRows) {
      this.dotKind = new Uint8Array(n);
      this.dotPhase = new Float32Array(n);
      this.dotFreq = new Float32Array(n);
      this.energy = new Float32Array(n);
      this.energyTmp = new Float32Array(n);
      this.heat = new Float32Array(n);
      this.bucketOf = new Uint8Array(n);
      this.bucketOrder = new Int32Array(n);
      this.koiFlag = new Uint8Array(n);
      this.koiShade = new Float32Array(n);
      this.koiKey = new Uint32Array(n);
      this.koiDepth = new Float32Array(n);
      this.koiColor = new Uint8Array(n);
      this.koiRay = new Uint8Array(n);
      this.koiShadow = new Uint8Array(n);
      this.fishStamp = new Uint32Array(n);
    }

    if (this.life && (this.cols !== prevCols || this.rows !== prevRows)) this.life.resize(this.cols, this.rows);

    for (let i = 0; i < n; i++) {
      const col = i % this.cols;
      const row = (i / this.cols) | 0;
      // No ambient dots: the grid stays dark. Only the wake lights cells.
      this.dotKind[i] = 0;
      this.dotPhase[i] = hash3(col, row, 23) * Math.PI * 2;
      this.dotFreq[i] = 0.3 + hash3(col, row, 37) * 1.1;
    }
    this.paintBackground();
  }

  private paintBackground() {
    const g = this.bg.getContext("2d");
    if (!g) return;
    const { width: W, height: H, dpr, cw, ch } = this;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = this.palette.bg;
    g.fillRect(0, 0, W, H);
    paintGrid(g, W, H, cw, ch, dpr, this.palette.grid);
  }

  render(world: World, dt: number) {
    const { ctx, dpr, cols, ch } = this;
    if (cols === 0) return;
    const t = world.time;
    this.time = t;

    this.consumeEvents(world);
    if (this.stage === "spine" || this.koiOpacity <= 0) {
      this.koiFlag.fill(0);
      this.koiShadow.fill(0);
    } else {
      this.rasterizeKoi(world.koi);
    }
    this.depositWake(world);
    this.diffuse(dt);
    // Koi only clear Life cells once they have mostly faded in.
    this.life?.step(dt, this.koiOpacity > 0.5 ? this.koiFlag : null, this.energy);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.bg, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.markFish(world);
    this.drawDots(t);

    ctx.font = `600 ${Math.round(ch * 0.74)}px ${this.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    this.drawLife();
    this.drawHeat();
    this.drawFish();
    if (this.koiOpacity > 0) {
      ctx.globalAlpha = this.koiOpacity;
      if (this.stage === "spine") this.drawSpines(world);
      else this.drawKoi(t);
      ctx.globalAlpha = 1;
    }
    this.drawPellets(world);
  }

  /** Live cells as plain blocks. Movers and oscillators stay bright; still lifes fade to ash. */
  private drawLife() {
    const { ctx, life, cols, cw, ch, palette } = this;
    if (!life || this.lifeOpacity <= 0) return;
    const { cells, age } = life;
    const grey: RGB = palette === PALETTES.dark ? [1, 1, 1] : [35, 35, 35];
    ctx.globalAlpha = this.lifeOpacity;
    for (let i = 0; i < cells.length; i++) {
      if (!cells[i]) continue;
      const a = age[i];
      const level = a < 2 ? 228 : 228 - 128 * Math.min(1, (a - 2) / 36);
      ctx.fillStyle = palette === PALETTES.dark ? rgb(grey, level) : `rgba(35,35,35,${(1 - level / 255 + 0.1).toFixed(2)})`;
      ctx.fillRect((i % cols) * cw + 1, ((i / cols) | 0) * ch + 1, cw - 1, ch - 1);
    }
    ctx.globalAlpha = 1;
  }

  // ── simulation → field ──────────────────────────────────────────────

  private cellIndex(x: number, y: number) {
    const c = Math.floor(x / this.cw);
    const r = Math.floor(y / this.ch);
    if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
    return r * this.cols + c;
  }

  private stamp(field: Float32Array, x: number, y: number, radius: number, amount: number) {
    const c0 = Math.floor(x / this.cw);
    const r0 = Math.floor(y / this.ch);
    for (let r = r0 - radius; r <= r0 + radius; r++) {
      for (let c = c0 - radius; c <= c0 + radius; c++) {
        if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) continue;
        const d = Math.hypot(c - c0, (r - r0) * 1.4);
        if (d > radius + 0.5) continue;
        const i = r * this.cols + c;
        field[i] = Math.min(1.6, field[i] + amount * (1 - d / (radius + 1)));
      }
    }
  }

  private consumeEvents(world: World) {
    for (const e of world.events) {
      if (e.kind === "eat") {
        // A gulp at the surface: a few crumbs and a ring.
        this.stamp(this.heat, e.x, e.y, 1, 0.9);
        this.stamp(this.energy, e.x, e.y, 3, 1);
      } else {
        this.stamp(this.energy, e.x, e.y, 6, 1.4);
      }
    }
    world.events.length = 0;
  }

  private depositWake(world: World) {
    const { energy } = this;
    for (const f of world.fish) {
      if (!f.alive) continue;
      const i = this.cellIndex(f.x, f.y);
      if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.012 + f.alarm * 0.03);
    }
    for (const k of world.koi) {
      // The tail sweeps the most water.
      for (let j = KOI_NODES - 6; j < KOI_NODES; j++) {
        const i = this.cellIndex(k.nodes[j * 2], k.nodes[j * 2 + 1]);
        if (i >= 0) energy[i] = Math.min(1.6, energy[i] + 0.04 + k.speed * 0.0015);
      }
    }
    if (world.pointer.active) {
      this.stamp(energy, world.pointer.x, world.pointer.y, 1, 0.08);
    }
  }

  /** Blur + decay so wakes spread out like ripples and fade. */
  private diffuse(dt: number) {
    const { cols, rows, energy, energyTmp: tmp, heat } = this;
    const decay = Math.exp(-dt * 1.5);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const l = c > 0 ? energy[i - 1] : energy[i];
        const rt = c < cols - 1 ? energy[i + 1] : energy[i];
        const u = r > 0 ? energy[i - cols] : energy[i];
        const d = r < rows - 1 ? energy[i + cols] : energy[i];
        tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay;
      }
    }
    this.energy = tmp;
    this.energyTmp = energy;
    const heatDecay = Math.exp(-dt * 2.2);
    for (let i = 0; i < heat.length; i++) heat[i] *= heatDecay;
  }

  // ── koi ─────────────────────────────────────────────────────────────

  /** The colour of the body at s along, v across (−1 → 1). */
  private bodyColor(s: number, v: number, L: number) {
    const look = this.look;
    let c = look.base;
    if (look.head !== undefined && s < 0.12 + 0.015 * Math.sin(v * 3)) c = look.head;
    if (look.sides !== undefined && Math.abs(v) > (look.sidesFrom ?? 1) && s > 0.1 && s < 0.82) c = look.sides;
    for (const p of look.patches) if (inPatch(s, v, p)) c = p.c;
    if (look.doitsu && s > 0.16 && s < 0.76 && Math.abs(v) < 0.22) {
      // The row of big mirror scales down a doitsu koi's back.
      if (Math.floor((s * L) / (this.cw * 1.4)) % 2 === 0) c = SLATE;
    }
    return c;
  }

  /** Inside a rounded fin paddle growing out of (u0, a0) in body pixels, swept back by `sweep` radians. */
  private inFin(u: number, a: number, u0: number, a0: number, length: number, width: number, sweep: number) {
    const dx = Math.sin(sweep);
    const dy = Math.cos(sweep);
    const ru = u - u0;
    const ra = a - a0;
    const along = ru * dx + ra * dy;
    if (along < -width * 0.3 || along > length) return -1;
    const across = ru * dy - ra * dx;
    // Narrow at the root, fanning out to a rounded tip.
    const k = clamp(along / length, 0, 1);
    const half = width * (0.45 + 0.55 * Math.sin(k * Math.PI * 0.62)) * (k > 0.8 ? Math.sqrt(1 - ((k - 0.8) / 0.2) ** 2) : 1);
    if (Math.abs(across) > half) return -1;
    return k;
  }

  /**
   * Classify one point against the current koi (spine/arc already built).
   * Body coordinates: u along the spine (0 snout → L tail), a across it. Points past either
   * end of the spine are measured along its last segment, so the tail fan can reach beyond.
   * Writes hit* fields and returns whether the point is on the koi.
   */
  private sampleKoi(px: number, py: number, L: number) {
    const { spine, arc } = this;
    const N = KOI_NODES;
    let best = Infinity;
    let bk = 0;
    let braw = 0;
    let bu = 0;
    let blen = 1;
    let bcross = 0;
    for (let k = 0; k < N - 1; k++) {
      const ax = spine[k * 2];
      const ay = spine[k * 2 + 1];
      const sx = spine[(k + 1) * 2] - ax;
      const sy = spine[(k + 1) * 2 + 1] - ay;
      const len2 = sx * sx + sy * sy || 1;
      const raw = ((px - ax) * sx + (py - ay) * sy) / len2;
      const u = clamp(raw, 0, 1);
      const qx = ax + sx * u;
      const qy = ay + sy * u;
      const d2 = (px - qx) ** 2 + (py - qy) ** 2;
      if (d2 < best) {
        best = d2;
        bk = k;
        braw = raw;
        bu = u;
        blen = Math.sqrt(len2);
        bcross = sx * (py - ay) - sy * (px - ax);
      }
    }

    const sign = bcross >= 0 ? 1 : -1;
    const dist = Math.sqrt(best);
    let along: number;
    let a: number;
    if (bk === N - 2 && braw > 1) {
      along = arc[N - 1] + (braw - 1) * blen;
      a = Math.abs(bcross) / blen;
    } else if (bk === 0 && braw < 0) {
      along = braw * blen;
      a = Math.abs(bcross) / blen;
    } else {
      along = arc[bk] + bu * blen;
      a = dist;
    }
    const u = (along * L) / this.arcTotal;
    const s = u / L;
    this.hitDist = dist;
    this.hitS = s;
    this.hitV = a * sign;

    // Spine direction (snout → tail) and the outward normal on this side, for lighting and fin rays.
    const tx = (spine[(bk + 1) * 2] - spine[bk * 2]) / blen;
    const ty = (spine[(bk + 1) * 2 + 1] - spine[bk * 2 + 1]) / blen;
    const nx = -ty * sign;
    const ny = tx * sign;
    const look = this.look;

    const w = koiHalfWidth(s) * L;
    if (s >= 0 && a <= w) {
      const across = a / (w || 1);
      const v = across * sign;
      // Rounded back lit from the top-left; flanks fall off into shadow.
      const facing = (nx * -0.6 + ny * -0.8) * across;
      let shade = 0.62 - across * across * 0.36 + facing * 0.22;
      let flag = FLAG_BODY;
      let color = this.bodyColor(s, v, L);
      const dorsal = this.longFins ? [0.32, 0.68] : [0.36, 0.6];
      if (s > 0.05 && s < 0.085 && across > 0.66) {
        flag = FLAG_EYE;
        shade = 0;
      } else if (s > dorsal[0] && s < dorsal[1] && across < 0.13) {
        // The dorsal fin, seen edge-on from above as a darker line down the back.
        flag = FLAG_DORSAL;
        shade *= 0.78;
      } else if (look.metallic && Math.sin(s * 15 - this.time * 1.3 + v * 1.6 + this.koiId) > 0.86 - 0.3 * (1 - across)) {
        // A band of light sliding down a metallic koi.
        flag = FLAG_GLINT;
        shade = Math.min(1, shade + 0.3);
      } else if (look.net >= 0.2 && s > 0.12 && s < 0.82) {
        // Reticulation: staggered rows of scales, the net between them a shade darker.
        const pu = this.cw * 1.3;
        const pv = this.ch * 0.8;
        const row = Math.floor((v * w) / pv);
        const gu = (s * L) / pu + (row & 1) * 0.5;
        const fu = gu - Math.floor(gu) - 0.5;
        if (Math.abs(fu) > 0.3) {
          flag = FLAG_NET;
          shade *= 1 - look.net;
        }
      }
      if (s < 0.03) shade = Math.max(shade, 0.72);
      this.hitFlag = flag;
      this.hitShade = shade;
      this.hitColor = color;
      return true;
    }

    // Fins: pectorals and pelvics on this side, then the tail fan.
    const long = this.longFins;
    const sweep = sign > 0 ? this.pecSweepRight : this.pecSweepLeft;
    let k = this.inFin(u, a, 0.17 * L, koiHalfWidth(0.17) * L * 0.85, (long ? 0.16 : 0.11) * L, (long ? 0.05 : 0.04) * L, sweep);
    let root = 0.17;
    if (k < 0) {
      k = this.inFin(u, a, 0.5 * L, koiHalfWidth(0.5) * L * 0.8, (long ? 0.07 : 0.04) * L, (long ? 0.022 : 0.016) * L, 1.05 + sweep * 0.2);
      root = 0.5;
    }
    if (k < 0) {
      // The tail fan: a lobe each side of the stalk, forked between them.
      const spread = this.tailSpread;
      k = this.inFin(u, a, 0.79 * L, 0, (long ? 0.32 : 0.2) * L, (long ? 0.06 : 0.045) * L, Math.PI / 2 - spread);
      root = 0.79;
    }
    if (k < 0) return false;

    // Ray direction on screen: from the fin's root out to this point.
    const u0 = root * L;
    const a0 = root === 0.79 ? 0 : koiHalfWidth(root) * L * 0.85;
    const rx = tx * (u - u0) + nx * (a - a0);
    const ry = ty * (u - u0) + ny * (a - a0);
    let angle = Math.atan2(ry, rx);
    if (angle < 0) angle += Math.PI;
    this.hitRay = Math.round(angle / (Math.PI / 4)) % 4;

    let color = look.fin;
    if (root === 0.17) {
      if (look.finRoot !== undefined && k < 0.45) color = look.finRoot;
      if (look.finStripes && Math.sin(k * 20 + this.koiId * 1.7) > 0.72) color = BLACK;
    }
    this.hitFlag = FLAG_FIN;
    // Fins are thin: most opaque at the root, clearing toward the edge.
    this.hitShade = 0.75 - 0.5 * k;
    this.hitColor = color;
    return true;
  }

  /** Smooth, undulating render spine from the sim spine, then supersample every cell around the koi. */
  private rasterizeKoi(koi: Koi[]) {
    const { koiFlag, koiShade, koiKey, koiDepth, koiColor, koiRay, koiShadow, spine, arc, cw, ch, cols, rows } = this;
    koiFlag.fill(0);
    koiShadow.fill(0);

    for (const k of koi) {
      const L = k.length;
      const N = KOI_NODES;
      const n = k.nodes;
      const swim = clamp(k.speed / 34, 0.45, 1.4);
      const key = `${k.id}:${k.kind}`;
      let look = this.looks.get(key);
      if (!look) this.looks.set(key, (look = makeLook(k.kind, k.id)));
      this.look = look;
      this.koiId = k.id;
      this.longFins = k.fins === "long";

      // Travelling body wave, most of it behind the shoulders.
      for (let j = 0; j < N; j++) {
        const s = j / (N - 1);
        const a = Math.max(0, j - 1);
        const b = Math.min(N - 1, j + 1);
        let tx = n[a * 2] - n[b * 2];
        let ty = n[a * 2 + 1] - n[b * 2 + 1];
        const tl = Math.hypot(tx, ty) || 1;
        tx /= tl;
        ty /= tl;
        const amp = L * 0.05 * (0.05 + 0.95 * Math.pow(s, 1.8)) * swim;
        const off = amp * Math.sin(k.phase - s * 4.6);
        spine[j * 2] = n[j * 2] - ty * off;
        spine[j * 2 + 1] = n[j * 2 + 1] + tx * off;
      }
      arc[0] = 0;
      for (let j = 1; j < N; j++) {
        arc[j] = arc[j - 1] + Math.hypot(spine[j * 2] - spine[(j - 1) * 2], spine[j * 2 + 1] - spine[(j - 1) * 2 + 1]);
      }
      this.arcTotal = arc[N - 1] || 1;

      // Pectorals: they row slowly at a glide, fold back as the koi speeds up, and the outside one flares into a turn.
      const tuck = clamp((k.speed - 22) / 24, 0, 1) * 0.45;
      const row = 0.22 * Math.sin(k.phase * 0.55) * (1 - tuck);
      const bank = clamp(k.turn * 0.5, -0.4, 0.4);
      this.pecSweepRight = clamp(0.62 + tuck + row + bank, 0.3, 1.4);
      this.pecSweepLeft = clamp(0.62 + tuck - row - bank, 0.3, 1.4);
      this.tailSpread = (this.longFins ? 0.3 : 0.36) + 0.06 * Math.sin(k.phase * 0.5);

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let j = 0; j < N; j++) {
        minX = Math.min(minX, spine[j * 2]);
        maxX = Math.max(maxX, spine[j * 2]);
        minY = Math.min(minY, spine[j * 2 + 1]);
        maxY = Math.max(maxY, spine[j * 2 + 1]);
      }
      const reach = L * (this.longFins ? 0.4 : 0.26);
      const c0 = Math.max(0, Math.floor((minX - reach) / cw));
      const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw));
      const r0 = Math.max(0, Math.floor((minY - reach) / ch));
      const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch));
      if (c0 > c1 || r0 > r1) continue;

      const skipBeyond = reach + Math.hypot(cw, ch);
      const shadowDc = Math.round((L * 0.035) / cw) + 1;
      const shadowDr = Math.round((L * 0.02) / ch) + 1;

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const x = c * cw;
          const y = r * ch;
          const centerHit = this.sampleKoi(x + cw / 2, y + ch / 2, L);
          if (!centerHit && this.hitDist > skipBeyond) continue;
          const flag = this.hitFlag;
          const shade = this.hitShade;
          const color = this.hitColor;
          const ray = this.hitRay;
          const s = this.hitS;
          const v = this.hitV;

          let hits = centerHit ? 1 : 0;
          for (let j = 0; j < SUBSAMPLES.length; j += 2) {
            if (this.sampleKoi(x + SUBSAMPLES[j] * cw, y + SUBSAMPLES[j + 1] * ch, L)) hits++;
          }
          if (hits === 0) continue;
          const coverage = hits / 5;

          const i = r * cols + c;
          // Body-anchored key so each glyph rides along with the skin.
          koiKey[i] = (hash3(Math.round(s * 52), Math.round(v / (cw * 0.9)), k.id) * 4294967295) >>> 0;
          koiDepth[i] = k.depth;
          koiColor[i] = centerHit ? color : look.base;

          if (centerHit && (coverage >= 0.6 || flag === FLAG_FIN)) {
            koiFlag[i] = flag;
            koiShade[i] = clamp(shade, 0, 1);
            koiRay[i] = ray;
            if (flag !== FLAG_FIN) {
              const sc = c + shadowDc;
              const sr = r + shadowDr;
              if (sc < cols && sr < rows) koiShadow[sr * cols + sc] = 1;
            }
          } else {
            koiFlag[i] = FLAG_EDGE;
            koiShade[i] = coverage;
          }
        }
      }
    }
  }

  private drawKoi(t: number) {
    const { ctx, cols, rows, cw, ch, koiFlag, koiShade, koiKey, koiDepth, koiColor, koiRay, palette, stage } = this;
    const n = cols * rows;
    const base = ctx.globalAlpha;
    for (let i = 0; i < n; i++) {
      const flag = koiFlag[i];
      if (!flag) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      const x = col * cw;
      const y = row * ch;
      const key = koiKey[i];
      const shade = koiShade[i];
      const dim = 0.72 + 0.28 * koiDepth[i];
      const c = palette.koi[koiColor[i]];

      if (flag === FLAG_EDGE) {
        // Soft, anti-aliased silhouette: no block, just a light glyph.
        if (stage === "silhouette") ctx.fillStyle = palette.flat;
        else ctx.fillStyle = palette.edge(c, (0.6 + 0.4 * shade) * dim);
        const set = shade >= 0.5 ? EDGE_HEAVY : EDGE_LIGHT;
        ctx.fillText(set[(key >>> 8) % set.length], x + cw / 2, y + ch / 2 + 1);
        continue;
      }

      if (flag === FLAG_FIN) {
        // Thin and translucent: a faint wash of colour, with the rays drawn over it.
        ctx.globalAlpha = base * (stage === "silhouette" ? 0.5 : 0.12 + 0.2 * shade);
        ctx.fillStyle = stage === "silhouette" ? palette.flat : rgb(c, 0.95 * dim);
        ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
        ctx.globalAlpha = base;
        if (stage !== "full") continue;
        ctx.globalAlpha = base * (0.45 + 0.5 * shade);
        ctx.fillStyle = rgb(c, 1.05 * dim);
        ctx.fillText(RAY_GLYPHS[koiRay[i]], x + cw / 2, y + ch / 2 + 1);
        ctx.globalAlpha = base;
        continue;
      }

      // Blocks: the koi's colour, lit from the top left.
      const light = flag === FLAG_EYE ? 0.12 : (0.7 + 0.5 * shade) * dim;
      ctx.fillStyle = stage === "silhouette" ? palette.flat : rgb(c, light);
      ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
      if (stage !== "full") continue;

      let glyph: string;
      let color: string;
      // Colours re-roll on a staggered clock so a wet back glistens now and then.
      const tick = Math.floor(t * 2 + (key % 997) / 97);
      const roll = hash3(key, tick, 7);
      if (flag === FLAG_EYE) {
        glyph = "o";
        color = palette.eye;
      } else if (flag === FLAG_GLINT) {
        glyph = roll < 0.5 ? "*" : "+";
        color = palette.glint;
      } else if (flag === FLAG_DORSAL) {
        glyph = DORSAL_GLYPHS[(key >>> 8) % DORSAL_GLYPHS.length];
        color = rgb(c, light * 0.55);
      } else {
        const jitter = ((key >>> 4) % 3) - 1;
        glyph = flag === FLAG_NET
          ? NET_GLYPHS[(key >>> 8) % NET_GLYPHS.length]
          : SKIN_RAMP[clamp(Math.floor((1 - shade) * 8.99) + jitter, 0, SKIN_RAMP.length - 1)];
        // Glyphs sit a shade darker than their block, so texture never fights the pattern. Sumi gets lighter glyphs.
        if (koiColor[i] === BLACK) color = rgb(palette.koi[SLATE], 0.9 + shade * 0.5);
        else if (roll < 0.025) color = palette.glint;
        else color = rgb(c, light * 0.8);
      }
      ctx.fillStyle = color;
      ctx.fillText(glyph, x + cw / 2, y + ch / 2 + 1);
    }
  }

  /** Spine stage: the simulation skeleton alone, twenty points following the snout. */
  private drawSpines(world: World) {
    const { ctx, palette } = this;
    ctx.strokeStyle = palette.line;
    ctx.fillStyle = palette.line;
    ctx.lineWidth = 1;
    for (const k of world.koi) {
      const n = k.nodes;
      ctx.beginPath();
      ctx.moveTo(n[0], n[1]);
      for (let j = 1; j < KOI_NODES; j++) ctx.lineTo(n[j * 2], n[j * 2 + 1]);
      ctx.stroke();
      for (let j = 0; j < KOI_NODES; j++) ctx.fillText(j === 0 ? "o" : "+", n[j * 2], n[j * 2 + 1]);
    }
  }

  /** Pellets float on the surface, over the koi, and fade as they go soggy. */
  private drawPellets(world: World) {
    const { ctx, cw, ch, palette } = this;
    for (const p of world.pellets) {
      if (!p.alive) continue;
      const i = this.cellIndex(p.x, p.y);
      if (i < 0) continue;
      const age = world.time - p.born;
      const a = clamp(Math.min(age * 4, (PELLET_LIFE - age) / 6), 0, 1);
      ctx.fillStyle = rgb(palette.pellet, 1, a);
      ctx.fillText("o", (i % this.cols) * cw + cw / 2, ((i / this.cols) | 0) * ch + ch / 2 + 1);
    }
  }

  // ── fish, dots, heat ────────────────────────────────────────────────

  /**
   * Snap each fish to a cell and bucket it by brightness: far fish are dim,
   * near fish brighter, and turning or panicking fish glint. Nearer fish
   * claim a cell first when two land in the same one.
   */
  private markFish(world: World) {
    const { fishStamp, fishBuckets, koiFlag } = this;
    const frame = ++this.frameId;
    for (const bucket of fishBuckets) bucket.length = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const f of world.fish) {
        if (!f.alive || (f.depth > 0.78 ? 0 : 1) !== pass) continue;
        const i = this.cellIndex(f.x, f.y);
        if (i < 0 || fishStamp[i] === frame || koiFlag[i]) continue;
        fishStamp[i] = frame;
        const glint = clamp(Math.abs(f.turn) / 3.5, 0, 1);
        const v = 0.3 + (0.4 * (f.depth - 0.55)) / 0.45 + 0.3 * Math.max(glint, f.alarm);
        fishBuckets[clamp(Math.floor(v * FISH_ALPHAS.length), 0, FISH_ALPHAS.length - 1)].push(i);
      }
    }
  }

  private drawFish() {
    const { ctx, cw, ch, cols, fishBuckets } = this;
    for (let b = 0; b < fishBuckets.length; b++) {
      const bucket = fishBuckets[b];
      if (!bucket.length) continue;
      ctx.fillStyle = this.fishStyles[b];
      for (const i of bucket) {
        ctx.fillText("-", (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2 + 1);
      }
    }
  }

  private drawHeat() {
    const { ctx, heat, cols, cw, ch, palette } = this;
    for (let i = 0; i < heat.length; i++) {
      const h = heat[i];
      if (h < 0.08) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      const [r, g, b] = h > 0.5 ? palette.heatHot : palette.heatCool;
      ctx.fillStyle = `rgba(${r},${g},${b},${(h > 0.5 ? h : h * 1.6).toFixed(2)})`;
      ctx.fillText(h > 0.6 ? "*" : "·", col * cw + cw / 2, row * ch + ch / 2 + 1);
    }
  }

  /**
   * Every cell's dot twinkles on its own clock, is modulated by slow
   * caustic light bands, and flares where the wake field is strong.
   * Dots are bucketed by colour/alpha so each bucket is one fillStyle.
   */
  private drawDots(t: number) {
    const { ctx, cols, rows, cw, ch, dotKind, dotPhase, dotFreq, energy, koiFlag, koiShadow, fishStamp, frameId } = this;
    const { bucketOf, bucketOrder, bucketCounts } = this;
    const n = cols * rows;
    const SKIP = bucketCounts.length - 1;
    bucketCounts.fill(0);

    for (let i = 0; i < n; i++) {
      const e = energy[i];
      const kind = dotKind[i];
      if ((koiFlag[i] && koiFlag[i] !== FLAG_FIN) || fishStamp[i] === frameId || (kind === 0 && e < 0.45)) {
        bucketOf[i] = SKIP;
        continue;
      }
      let bucket: number;
      if (e > 0.45) {
        const level = clamp(Math.floor((e - 0.45) * 5), 0, ALPHA_LEVELS - 1);
        bucket = WAKE * ALPHA_LEVELS + level;
      } else {
        const col = i % cols;
        const row = (i / cols) | 0;
        // Dots stay bright and crisp; the twinkle is a gentle breathe, not a fade.
        const twinkle = 0.5 + 0.5 * Math.sin(t * dotFreq[i] + dotPhase[i]);
        const caustic = 0.85 + 0.15 * Math.sin(col * 0.11 + t * 0.35) * Math.sin(row * 0.17 - t * 0.27);
        let v = clamp((0.55 + 0.45 * twinkle) * caustic + e * 2, 0, 1);
        if (koiShadow[i]) v *= 0.2;
        bucket = (kind - 1) * ALPHA_LEVELS + clamp(Math.floor(v * ALPHA_LEVELS), 0, ALPHA_LEVELS - 1);
      }
      bucketOf[i] = bucket;
      bucketCounts[bucket]++;
    }

    // Counting sort cells by bucket.
    const starts = new Int32Array(bucketCounts.length);
    for (let b = 1; b < bucketCounts.length; b++) starts[b] = starts[b - 1] + bucketCounts[b - 1];
    const cursor = starts.slice();
    for (let i = 0; i < n; i++) {
      const b = bucketOf[i];
      if (b !== SKIP) bucketOrder[cursor[b]++] = i;
    }

    const small = Math.max(2, Math.round(cw * 0.19));
    const large = small + 1;
    for (let b = 0; b < SKIP; b++) {
      const count = bucketCounts[b];
      if (!count) continue;
      ctx.fillStyle = this.dotStyles[b];
      const size = b >= WAKE * ALPHA_LEVELS ? large : small;
      const start = starts[b];
      for (let k = start; k < start + count; k++) {
        const i = bucketOrder[k];
        const col = i % cols;
        const row = (i / cols) | 0;
        // Sit the dot low-right in its cell, as in the reference.
        ctx.fillRect(Math.round(col * cw + cw * 0.66 - size / 2), Math.round(row * ch + ch * 0.64 - size / 2), size, size);
      }
    }
  }
}
