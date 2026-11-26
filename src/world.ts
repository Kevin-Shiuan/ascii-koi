/**
 * Artificial-life sim for the hero: a koi pond, with schools of tiny fish weaving between the koi.
 *
 * Fish: Reynolds boids (separation / alignment / cohesion) in Couzin-style
 * zones, with a blind spot behind each fish. Alarm spreads from fish to fish
 * through the school (a "wave of agitation"), so a whole school bolts even
 * when only its edge can see a koi coming. Fleeing fish break sideways around
 * the koi's path, the same fountain effect seen in real bait balls.
 *
 * Koi: Reynolds steering (wander + seek + separation) on a follow-the-leader
 * spine. They cruise a lazy circuit, easing between a slow glide and a few
 * strong strokes. Hunger builds over time; food pellets scattered on the
 * surface (a click, or the keeper now and then) draw the nearest hungry koi,
 * which gulp them down and leave a ring on the water.
 */
import { angleDiff, clamp, current, rand, randInt, TAU } from "./math";
import { pickSpecies, SPECIES } from "./species";

export const KOI_NODES = 20;

/** Koi varieties: the colour and pattern on the body. The body shape is the same for all of them. */
export type KoiKind =
  | "kohaku"
  | "tancho"
  | "sanke"
  | "showa"
  | "utsuri"
  | "ogon"
  | "platinum"
  | "kigoi"
  | "chagoi"
  | "asagi"
  | "shusui";

/** Which koi to put in the pond; size is relative to the biggest. Long fins make a butterfly koi. */
export type KoiSpec = { kind: KoiKind; size: number; fins?: "short" | "long" };

// The landing hero: a small mixed pond, the big kohaku nearest the surface.
const DEFAULT_KOI: KoiSpec[] = [
  { kind: "kohaku", size: 1 },
  { kind: "ogon", size: 0.8 },
  { kind: "sanke", size: 0.88 },
  { kind: "showa", size: 0.76 },
];

export interface Fish {
  x: number;
  y: number;
  vx: number;
  vy: number;
  species: number;
  /** 0 calm → 1 panicking. Spreads to neighbours. */
  alarm: number;
  alive: boolean;
  /** Tail-beat phase. */
  phase: number;
  /** Smoothed angular velocity (rad/s); hard turns flash silver. */
  turn: number;
  /** 0.55 far → 1 near. */
  depth: number;
  /** Rotation sense shared by a school when it mills into a bait ball. */
  millDir: 1 | -1;
}

export interface Koi {
  id: number;
  kind: KoiKind;
  fins: "short" | "long";
  length: number;
  /** Spine positions, snout first: [x0, y0, x1, y1, ...]. */
  nodes: Float32Array;
  heading: number;
  speed: number;
  /** Tail-beat phase; drives the body wave in the renderer. */
  phase: number;
  /** Smoothed angular velocity (rad/s); the pectorals flare into turns. */
  turn: number;
  hunger: number;
  wander: number;
  orbitDir: 1 | -1;
  orbitRadius: number;
  target: Pellet | null;
  retargetAt: number;
  /** 0 far / dim → 1 near / bright. */
  depth: number;
}

/** A food pellet floating on the surface. */
export interface Pellet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alive: boolean;
  /** When it landed; old pellets go soggy and sink out of sight. */
  born: number;
}

export interface WorldEvent {
  kind: "eat" | "splash";
  x: number;
  y: number;
}

const FISH_SEPARATION_K = 420;
const FISH_ALIGN_K = 1.4;
const FISH_COHESION_K = 1;
const FISH_FLEE_K = 1100;
const BLIND_COS = -0.6; // ~127° either side of the heading is visible
/** Seconds a pellet floats before it sinks. */
export const PELLET_LIFE = 40;
const MAX_PELLETS = 80;

export class World {
  width = 0;
  height = 0;
  time = 0;
  fish: Fish[] = [];
  koi: Koi[] = [];
  pellets: Pellet[] = [];
  events: WorldEvent[] = [];
  pointer = { x: 0, y: 0, active: false };

  /** Fish neighbourhood radius; the spatial hash bucket size matches it. */
  private perception = 60;
  /** Per-species personal space in px (x, y). */
  private sepX: number[] = [];
  private sepY: number[] = [];
  private foreignSep = 40;
  private bucketCols = 0;
  private bucketRows = 0;
  private bucketHead = new Int32Array(0);
  private bucketCount = new Uint16Array(0);
  private bucketNext = new Int32Array(0);
  private nextFeed = 6;
  private tmp = { x: 0, y: 0 };

  /**
   * fishCount overrides the area-based population (the sidebar wants a single small school).
   * clearCentre keeps a soft ellipse in the middle free for a headline; off for a plain tank.
   * contain keeps every koi wholly in frame instead of letting bodies dip off the edges.
   * feed has the keeper scatter a few pellets now and then, so the koi feed without a click.
   */
  constructor(
    private koiSpecs: KoiSpec[] = DEFAULT_KOI,
    private fishCount?: number,
    private clearCentre = true,
    private contain = false,
    private feed = true,
  ) {}

  /** How far every part of a contained koi keeps from the frame: fins and tail lobes reach about this far out. */
  private insetFor(length: number) {
    return length * 0.3;
  }

  /** Slide a spine so none of it lies within `inset` of the frame. */
  private fitInFrame(nodes: Float32Array, inset: number) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < KOI_NODES; k++) {
      const x = nodes[k * 2];
      const y = nodes[k * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const sx = minX < inset ? inset - minX : maxX > this.width - inset ? this.width - inset - maxX : 0;
    const sy = minY < inset ? inset - minY : maxY > this.height - inset ? this.height - inset - maxY : 0;
    if (sx === 0 && sy === 0) return;
    for (let k = 0; k < KOI_NODES; k++) {
      nodes[k * 2] += sx;
      nodes[k * 2 + 1] += sy;
    }
  }

  resize(width: number, height: number, cellW: number, cellH: number) {
    const first = this.width === 0;
    this.width = width;
    this.height = height;
    // Spacing is set in grid cells so every fish lands in its own cell.
    this.sepX = SPECIES.map((sp) => sp.spacing[0] * cellW);
    this.sepY = SPECIES.map((sp) => sp.spacing[1] * cellH);
    this.perception = Math.max(cellH * 3, cellW * 5.5);
    this.foreignSep = cellW * 3;

    if (first || this.fish.length === 0) {
      this.seed();
      return;
    }
    for (const f of this.fish) {
      f.x = clamp(f.x, 0, width);
      f.y = clamp(f.y, 0, height);
    }
  }

  seed() {
    const { width: W, height: H } = this;
    const minSide = Math.min(W, H);
    const baseLength = clamp(minSide * 0.42, 170, 420);
    const koiCount = this.koiSpecs.length;

    this.koi = [];
    for (let i = 0; i < koiCount; i++) {
      const { kind, size, fins = "short" } = this.koiSpecs[i];
      const length = baseLength * size;
      const inset = this.insetFor(length);
      // Contained koi circle inside the inset, so the circuit itself never asks them to leave.
      const orbitRadius = this.contain
        ? Math.max(minSide * 0.1, Math.min(minSide * rand(0.28, 0.4), H / 2 - inset - length * 0.1, (W / 2 - inset) / ((W / minSide) * 0.9)))
        : minSide * rand(0.28, 0.4);
      const a = (i / koiCount) * TAU + rand(-0.4, 0.4);
      const orbitDir: 1 | -1 = i % 2 === 0 ? 1 : -1;
      const x = W / 2 + Math.cos(a) * orbitRadius * (W / minSide) * 0.9;
      const y = H / 2 + Math.sin(a) * orbitRadius;
      const heading = a + (orbitDir * Math.PI) / 2;
      const nodes = new Float32Array(KOI_NODES * 2);
      const seg = length / (KOI_NODES - 1);
      for (let n = 0; n < KOI_NODES; n++) {
        nodes[n * 2] = x - Math.cos(heading) * seg * n;
        nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
      }
      if (this.contain) this.fitInFrame(nodes, inset);
      this.koi.push({
        id: i + 1,
        kind,
        fins,
        length,
        nodes,
        heading,
        speed: 20,
        phase: rand(0, TAU),
        turn: 0,
        hunger: rand(0.25, 0.75),
        wander: 0,
        orbitDir,
        orbitRadius,
        target: null,
        retargetAt: 0,
        depth: clamp(size, 0, 1),
      });
    }
    // Smaller (deeper) koi draw first so the big one swims over them.
    this.koi.sort((a, b) => a.length - b.length);

    const total = this.fishCount ?? clamp(Math.round((W * H) / 4400), 85, 340);
    this.fish = [];
    while (this.fish.length < total) {
      const species = pickSpecies();
      const sp = SPECIES[species];
      const size = Math.min(randInt(sp.schoolSize[0], sp.schoolSize[1]), total - this.fish.length);
      const millDir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
      const cx = rand(W * 0.06, W * 0.94);
      const cy = rand(H * 0.08, H * 0.92);
      // Mostly level headings: fish cruise sideways far more than up or down.
      const dir = (Math.random() < 0.5 ? 0 : Math.PI) + rand(-0.5, 0.5);
      for (let k = 0; k < size; k++) {
        this.fish.push({
          x: cx + rand(-1, 1) * this.sepX[species] * Math.sqrt(size),
          y: cy + rand(-1, 1) * this.sepY[species] * Math.sqrt(size) * 0.6,
          vx: Math.cos(dir) * sp.cruise,
          vy: Math.sin(dir) * sp.cruise,
          species,
          alarm: 0,
          alive: true,
          phase: rand(0, TAU),
          turn: 0,
          depth: rand(0.55, 1),
          millDir,
        });
      }
    }
    this.bucketNext = new Int32Array(this.fish.length);
    this.pellets = [];
  }

  /** A click on the water: a ripple, and a pinch of food lands. */
  splash(x: number, y: number) {
    this.ripple(x, y);
    this.scatter(x, y, randInt(4, 7));
  }

  /** A ring on the water that sends the small fish bolting, with no food. */
  ripple(x: number, y: number) {
    this.events.push({ kind: "splash", x, y });
    const r = 240;
    for (const f of this.fish) {
      if (!f.alive) continue;
      const dx = f.x - x;
      const dy = f.y - y;
      const d = Math.hypot(dx, dy);
      if (d > r || d < 1e-3) continue;
      // Flash expansion: everybody nearby bolts straight out.
      const k = (1 - d / r) * 260;
      f.vx += (dx / d) * k;
      f.vy += (dy / d) * k;
      f.alarm = 1;
    }
  }

  /** Drop `count` pellets around (x, y), each with a little outward drift. */
  scatter(x: number, y: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = rand(0, TAU);
      const d = rand(4, 34);
      const pellet: Pellet = {
        x: clamp(x + Math.cos(a) * d, 4, this.width - 4),
        y: clamp(y + Math.sin(a) * d * 0.8, 4, this.height - 4),
        vx: Math.cos(a) * rand(4, 14),
        vy: Math.sin(a) * rand(4, 14),
        alive: true,
        born: this.time,
      };
      if (this.pellets.length >= MAX_PELLETS) this.pellets.shift();
      this.pellets.push(pellet);
    }
  }

  step(dt: number) {
    this.time += dt;
    this.rebuildHash();
    this.stepFish(dt);
    this.stepPellets(dt);
    this.stepKoi(dt);
  }

  private rebuildHash() {
    const size = this.perception;
    const pad = 2;
    this.bucketCols = Math.ceil(this.width / size) + pad * 2;
    this.bucketRows = Math.ceil(this.height / size) + pad * 2;
    const n = this.bucketCols * this.bucketRows;
    if (this.bucketHead.length !== n) {
      this.bucketHead = new Int32Array(n);
      this.bucketCount = new Uint16Array(n);
    }
    this.bucketHead.fill(-1);
    this.bucketCount.fill(0);
    if (this.bucketNext.length !== this.fish.length) {
      this.bucketNext = new Int32Array(this.fish.length);
    }
    for (let i = 0; i < this.fish.length; i++) {
      const f = this.fish[i];
      if (!f.alive) continue;
      const b = this.bucketOf(f.x, f.y);
      this.bucketNext[i] = this.bucketHead[b];
      this.bucketHead[b] = i;
      this.bucketCount[b]++;
    }
  }

  private bucketOf(x: number, y: number) {
    const size = this.perception;
    const c = clamp(Math.floor(x / size) + 2, 0, this.bucketCols - 1);
    const r = clamp(Math.floor(y / size) + 2, 0, this.bucketRows - 1);
    return r * this.bucketCols + c;
  }

  private stepFish(dt: number) {
    const { fish, koi, pointer, width: W, height: H, time } = this;
    const R = this.perception;
    const R2 = R * R;
    const foreignSep = this.foreignSep;
    const size = this.perception;
    const cols = this.bucketCols;
    const rows = this.bucketRows;
    const head = this.bucketHead;
    const next = this.bucketNext;
    const cur = this.tmp;
    const calmDecay = Math.exp(-dt * 0.7);
    const contagion = Math.min(1, dt * 6);

    for (let i = 0; i < fish.length; i++) {
      const f = fish[i];
      if (!f.alive) continue;
      const sp = SPECIES[f.species];
      // Alarmed fish want more room: the school flashes apart around a
      // koi and closes back up once the threat fades.
      const spread = 1 + 1.8 * f.alarm;
      const sepX = this.sepX[f.species] * spread;
      const sepY = this.sepY[f.species] * spread;

      const speed = Math.hypot(f.vx, f.vy) || 1;
      const hx = f.vx / speed;
      const hy = f.vy / speed;

      let ax = 0;
      let ay = 0;
      let sx = 0;
      let sy = 0;
      let avx = 0;
      let avy = 0;
      let cx = 0;
      let cy = 0;
      let n = 0;
      let neighbourAlarm = 0;

      const bc = clamp(Math.floor(f.x / size) + 2, 0, cols - 1);
      const br = clamp(Math.floor(f.y / size) + 2, 0, rows - 1);
      for (let r = Math.max(0, br - 1); r <= Math.min(rows - 1, br + 1); r++) {
        for (let c = Math.max(0, bc - 1); c <= Math.min(cols - 1, bc + 1); c++) {
          let j = head[r * cols + c];
          while (j !== -1) {
            if (j !== i) {
              const o = fish[j];
              const dx = o.x - f.x;
              const dy = o.y - f.y;
              const d2 = dx * dx + dy * dy;
              if (d2 < R2 && d2 > 1e-6) {
                const d = Math.sqrt(d2);
                // Blind zone directly behind the fish.
                if ((dx * hx + dy * hy) / d > BLIND_COS) {
                  // Elliptical personal space: wide along x, tight along y.
                  const qx = dx / sepX;
                  const qy = dy / sepY;
                  const q2 = qx * qx + qy * qy;
                  if (q2 < 1) {
                    const q = Math.sqrt(q2) || 1e-3;
                    const k = (1 - q) / q;
                    sx -= qx * k;
                    sy -= qy * k;
                  }
                  if (o.species === f.species) {
                    avx += o.vx;
                    avy += o.vy;
                    cx += dx;
                    cy += dy;
                    n++;
                  } else if (d < foreignSep) {
                    // Different species keep their own schools.
                    const k = ((1 - d / foreignSep) / d) * 0.6;
                    sx -= dx * k;
                    sy -= dy * k;
                  }
                  if (o.alarm > neighbourAlarm) neighbourAlarm = o.alarm;
                }
              }
            }
            j = next[j];
          }
        }
      }

      ax += sx * FISH_SEPARATION_K;
      ay += sy * FISH_SEPARATION_K;
      if (n > 0) {
        const alignK = FISH_ALIGN_K * sp.align;
        const cohesionK = FISH_COHESION_K * sp.cohesion * (1 - 0.8 * f.alarm);
        ax += (avx / n - f.vx) * alignK + (cx / n) * cohesionK;
        ay += (avy / n - f.vy) * alignK + (cy / n) * cohesionK;
        if (sp.mill > 0) {
          // Circle the local centre: the school spins into a bait ball.
          const cl = Math.hypot(cx, cy) || 1;
          ax += (-cy / cl) * f.millDir * sp.mill * (1 - f.alarm);
          ay += (cx / cl) * f.millDir * sp.mill * (1 - f.alarm);
        }
      }

      // Koi. They don't hunt the small fish, but a big body coming through still
      // parts a school. Distance is measured to the nearest point along the front
      // half of the koi, so fish also give the flanks a berth.
      let fear = 0;
      for (const k of koi) {
        const fearR = k.length * 0.45 + 40;
        let best = Infinity;
        let bx = 0;
        let by = 0;
        for (let j = 0; j <= 12; j += 3) {
          const nx = k.nodes[j * 2];
          const ny = k.nodes[j * 2 + 1];
          const d2 = (f.x - nx) ** 2 + (f.y - ny) ** 2;
          if (d2 < best) {
            best = d2;
            bx = nx;
            by = ny;
          }
        }
        const d = Math.sqrt(best);
        if (d >= fearR || d < 1e-3) continue;
        let w = 1 - d / fearR;
        w *= w * 0.6;
        const awayX = (f.x - bx) / d;
        const awayY = (f.y - by) / d;
        // Fountain effect: break to whichever side of the koi's path you're on.
        const khx = Math.cos(k.heading);
        const khy = Math.sin(k.heading);
        const side = khx * (f.y - k.nodes[1]) - khy * (f.x - k.nodes[0]) >= 0 ? 1 : -1;
        ax += (awayX * 0.7 - khy * side * 0.9) * FISH_FLEE_K * w;
        ay += (awayY * 0.7 + khx * side * 0.9) * FISH_FLEE_K * w;
        fear = Math.max(fear, Math.sqrt(w) * 0.7);
      }

      if (pointer.active) {
        const pr = 130;
        const dx = f.x - pointer.x;
        const dy = f.y - pointer.y;
        const d = Math.hypot(dx, dy);
        if (d < pr && d > 1e-3) {
          const w = (1 - d / pr) ** 2;
          ax += (dx / d) * FISH_FLEE_K * w;
          ay += (dy / d) * FISH_FLEE_K * w;
          fear = Math.max(fear, Math.sqrt(w) * 0.8);
        }
      }

      // Alarm: direct threat sets it, neighbours pass it along (slightly
      // weaker each hop), and it fades on its own.
      let alarm = Math.max(f.alarm * calmDecay, fear);
      const relayed = neighbourAlarm * 0.86;
      if (relayed > alarm) alarm += (relayed - alarm) * contagion;
      f.alarm = alarm;

      // Soft walls.
      const m = 36;
      if (f.x < m) ax += (m - f.x) * 7;
      else if (f.x > W - m) ax -= (f.x - (W - m)) * 7;
      if (f.y < m) ay += (m - f.y) * 7;
      else if (f.y > H - m) ay -= (f.y - (H - m)) * 7;

      // Ambient current and a little individual restlessness.
      current(f.x, f.y, time, cur);
      ax += cur.x * 0.5 + (Math.random() - 0.5) * sp.jitter;
      ay += cur.y * 0.5 + (Math.random() - 0.5) * sp.jitter;
      // Swim level, except when bolting from danger.
      ay -= f.vy * sp.verticalDrag * (1 - 0.7 * f.alarm);

      // Relax toward a preferred speed that rises with panic.
      const preferred = sp.cruise * (1 + 1.3 * f.alarm);
      ax += (preferred - speed) * hx * 1.6;
      ay += (preferred - speed) * hy * 1.6;

      const before = Math.atan2(f.vy, f.vx);
      f.vx += ax * dt;
      f.vy += ay * dt;
      const maxSpeed = sp.maxSpeed * (1 + 1.8 * f.alarm);
      const s = Math.hypot(f.vx, f.vy);
      if (s > maxSpeed) {
        f.vx *= maxSpeed / s;
        f.vy *= maxSpeed / s;
      } else if (s < sp.minSpeed && s > 1e-3) {
        f.vx *= sp.minSpeed / s;
        f.vy *= sp.minSpeed / s;
      }
      f.turn += (angleDiff(before, Math.atan2(f.vy, f.vx)) / dt - f.turn) * Math.min(1, dt * 8);
      f.phase += dt * (7 + Math.hypot(f.vx, f.vy) * 0.12);
      f.x = clamp(f.x + f.vx * dt, -60, W + 60);
      f.y = clamp(f.y + f.vy * dt, -60, H + 60);
    }
  }

  /** Pellets drift on the current, slow to a float, and sink once they go soggy. */
  private stepPellets(dt: number) {
    const { time, width: W, height: H } = this;
    const cur = this.tmp;
    const drag = Math.exp(-dt * 1.8);
    let alive = 0;
    for (const p of this.pellets) {
      if (!p.alive) continue;
      if (time - p.born > PELLET_LIFE) {
        p.alive = false;
        continue;
      }
      current(p.x, p.y, time, cur);
      p.vx = p.vx * drag + cur.x * 0.12 * dt * 6;
      p.vy = p.vy * drag + cur.y * 0.12 * dt * 6;
      p.x = clamp(p.x + p.vx * dt, 2, W - 2);
      p.y = clamp(p.y + p.vy * dt, 2, H - 2);
      alive++;
    }
    if (alive === 0 && this.pellets.length) this.pellets.length = 0;

    // The keeper: when the water has been empty a while, a pinch of food lands somewhere off the headline.
    if (this.feed && this.koi.length && time >= this.nextFeed) {
      this.nextFeed = time + rand(12, 20);
      if (alive < 4) {
        let x = rand(W * 0.12, W * 0.88);
        let y = rand(H * 0.15, H * 0.85);
        if (this.clearCentre && Math.abs(x - W / 2) < W * 0.3 && Math.abs(y - H / 2) < H * 0.16) {
          y = y < H / 2 ? H * rand(0.12, 0.3) : H * rand(0.7, 0.88);
        }
        if (this.contain) {
          const m = Math.min(W, H) * 0.15;
          x = clamp(x, m, W - m);
          y = clamp(y, m, H - m);
        }
        this.scatter(x, y, randInt(3, 6));
      }
    }
  }

  private stepKoi(dt: number) {
    const { koi, width: W, height: H, time } = this;
    const minSide = Math.min(W, H);
    const cxW = W / 2;
    const cyW = H / 2;

    for (const k of koi) {
      const L = k.length;
      const nodes = k.nodes;
      const hx = nodes[0];
      const hy = nodes[1];

      k.hunger = Math.min(1, k.hunger + dt * 0.04);

      // Momentum.
      let dx = Math.cos(k.heading);
      let dy = Math.sin(k.heading);

      // Wander: a slowly drifting offset on a circle ahead of the snout.
      k.wander = clamp(k.wander + (Math.random() - 0.5) * dt * 3.6, -1.2, 1.2);
      dx += Math.cos(k.heading + k.wander) * 0.5;
      dy += Math.sin(k.heading + k.wander) * 0.5;

      // Feed.
      if (time >= k.retargetAt) {
        k.target = this.findFood(k);
        k.retargetAt = time + 0.5;
      }
      const t = k.target;
      let feeding = false;
      let closing = 0;
      if (t && t.alive && k.hunger > 0.2) {
        const tx = t.x - hx;
        const ty = t.y - hy;
        const d = Math.hypot(tx, ty) || 1;
        const w = 1.2 + 2.2 * k.hunger;
        dx += (tx / d) * w;
        dy += (ty / d) * w;
        feeding = true;
        closing = clamp(1 - d / (L * 0.9), 0, 1);
      } else {
        // Patrol: a lazy circuit around the headline.
        const rx = (hx - cxW) / (W / minSide);
        const ry = hy - cyW;
        const r = Math.hypot(rx, ry) || 1;
        const radius = k.orbitRadius * (1 + 0.15 * Math.sin(time * 0.05 + k.id));
        const radial = clamp((radius - r) / radius, -1, 1);
        dx += ((-ry / r) * k.orbitDir + (rx / r) * radial * 0.9) * 0.55;
        dy += ((rx / r) * k.orbitDir + (ry / r) * radial * 0.9) * 0.55;
      }

      // Give other koi room.
      for (const other of koi) {
        if (other === k) continue;
        for (let j = 0; j < KOI_NODES; j += 4) {
          const ox = hx - other.nodes[j * 2];
          const oy = hy - other.nodes[j * 2 + 1];
          const d = Math.hypot(ox, oy);
          const range = (L + other.length) * 0.4;
          if (d < range && d > 1e-3) {
            const w = (1 - d / range) * (feeding ? 1.5 : 3);
            dx += (ox / d) * w;
            dy += (oy / d) * w;
          }
        }
      }

      // Keep the headline mostly clear: a soft elliptical no-swim zone.
      const ex = (hx - cxW) / (W * 0.3);
      const ey = (hy - cyW) / (H * 0.16);
      const e2 = ex * ex + ey * ey;
      if (this.clearCentre && e2 < 1) {
        const e = Math.sqrt(e2) || 1e-3;
        const w = (1 - e) * (feeding ? 1 : 2.5);
        dx += (ex / e) * w;
        dy += (ey / e) * w;
      }

      const inset = this.insetFor(L);
      if (this.contain) {
        // Containment: the whole animal stays in frame. The body swings wide of the snout's path
        // when the koi turns, so the distance to each wall is taken from whichever part of the
        // spine is nearest it; steering away from the wall draws the body after the snout, harder
        // the closer it gets, until the wall overrides the food.
        const band = L * 0.65;
        let minX = hx;
        let maxX = hx;
        let minY = hy;
        let maxY = hy;
        for (let j = 1; j < KOI_NODES; j++) {
          const x = nodes[j * 2];
          const y = nodes[j * 2 + 1];
          if (x < minX) minX = x;
          else if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          else if (y > maxY) maxY = y;
        }
        let px = 0;
        let py = 0;
        if (minX - inset < band) px += 1 - (minX - inset) / band;
        if (W - inset - maxX < band) px -= 1 - (W - inset - maxX) / band;
        if (minY - inset < band) py += 1 - (minY - inset) / band;
        if (H - inset - maxY < band) py -= 1 - (H - inset - maxY) / band;
        const m = Math.hypot(px, py);
        if (m > 1e-3) {
          // Ease in fast: most of the push arrives in the outer half of the band, so the turn
          // is made well before the line and the line itself is rarely touched.
          const w = Math.sqrt(Math.min(1, m)) * 8;
          dx += (px / m) * w;
          dy += (py / m) * w;
        }
      } else {
        // Turn back once the snout leaves the frame, so bodies dip off-screen
        // now and then but the koi never wander away for good.
        const over = Math.max(-hx, hx - W, -hy, hy - H);
        if (over > -L * 0.05) {
          const w = clamp((over + L * 0.05) / (L * 0.35), 0, 1) * 3.5;
          const toX = cxW - hx;
          const toY = cyW - hy;
          const d = Math.hypot(toX, toY) || 1;
          dx += (toX / d) * w;
          dy += (toY / d) * w;
        }
      }

      const desired = Math.atan2(dy, dx);
      // Koi turn tighter than their length suggests, but still can't pivot on the spot.
      const agility = Math.min(feeding ? 1.1 + closing * 0.8 : 0.6, 0.25 + k.speed / (L * 0.16));
      const maxTurn = agility * dt;
      const turned = clamp(angleDiff(k.heading, desired), -maxTurn, maxTurn);
      k.heading += turned;
      k.turn += (turned / dt - k.turn) * Math.min(1, dt * 3);

      // Cruise breathes between a slow glide and a few strong strokes, each koi on its own clock.
      const cruise = (16 + L * 0.03) * (0.75 + 0.35 * Math.sin(time * 0.21 + k.id * 2.3) * Math.sin(time * 0.083 + k.id));
      const targetSpeed = feeding ? (16 + L * 0.03) * (1.4 + closing * 0.3) : cruise;
      k.speed += (targetSpeed - k.speed) * Math.min(1, dt * 0.9);
      k.phase += dt * (1.4 + k.speed / 14);

      nodes[0] += Math.cos(k.heading) * k.speed * dt;
      nodes[1] += Math.sin(k.heading) * k.speed * dt;
      if (this.contain) {
        // The line itself, should steering not have been enough.
        nodes[0] = clamp(nodes[0], inset, W - inset);
        nodes[1] = clamp(nodes[1], inset, H - inset);
      }

      // Follow-the-leader spine, with a stiffness limit per joint so the
      // body bends into a C at most and never folds back on itself. A koi is
      // stiff through the head and shoulders and supple toward the tail.
      const seg = L / (KOI_NODES - 1);
      let prevAngle = k.heading + Math.PI;
      for (let j = 1; j < KOI_NODES; j++) {
        const px = nodes[(j - 1) * 2];
        const py = nodes[(j - 1) * 2 + 1];
        let angle = Math.atan2(nodes[j * 2 + 1] - py, nodes[j * 2] - px);
        const maxBend = 0.035 + 0.13 * (j / KOI_NODES);
        angle = prevAngle + clamp(angleDiff(prevAngle, angle), -maxBend, maxBend);
        nodes[j * 2] = px + Math.cos(angle) * seg;
        nodes[j * 2 + 1] = py + Math.sin(angle) * seg;
        prevAngle = angle;
      }
      // Last resort for a tail that swings past the line: slide the whole body in.
      if (this.contain) this.fitInFrame(nodes, inset);

      // Gulp: any pellet at the mouth goes down, and the surface rings.
      if (k.hunger > 0.05) {
        const mouthR = L * 0.06 + 6;
        const mx = nodes[0];
        const my = nodes[1];
        for (const p of this.pellets) {
          if (!p.alive) continue;
          if ((p.x - mx) ** 2 + (p.y - my) ** 2 < mouthR * mouthR) {
            p.alive = false;
            k.hunger = Math.max(0, k.hunger - 0.12);
            this.events.push({ kind: "eat", x: p.x, y: p.y });
          }
        }
      }
    }
  }

  /**
   * Pick the pellet that is cheapest to reach: close, and ahead rather than behind,
   * since turning round costs a koi more than swimming on.
   */
  private findFood(k: Koi): Pellet | null {
    const range = k.length * 2.2 + 220;
    const hx = k.nodes[0];
    const hy = k.nodes[1];
    const fx = Math.cos(k.heading);
    const fy = Math.sin(k.heading);
    const inset = this.contain ? this.insetFor(k.length) * 0.6 : 0;
    let best: Pellet | null = null;
    let bestScore = Infinity;
    let currentScore = Infinity;

    for (const p of this.pellets) {
      if (!p.alive) continue;
      // A contained koi can't reach food hugging the frame; don't let it pin the koi to the wall.
      if (inset && (p.x < inset || p.x > this.width - inset || p.y < inset || p.y > this.height - inset)) continue;
      const dx = p.x - hx;
      const dy = p.y - hy;
      const d = Math.hypot(dx, dy);
      if (d > range || d < 1e-3) continue;
      const cos = (dx * fx + dy * fy) / d;
      const score = d * (1 + (1 - cos) * 0.9);
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
      if (p === k.target) currentScore = score;
    }
    // Stick with the current pellet unless something is clearly better.
    if (k.target && currentScore < bestScore * 1.3) return k.target;
    return best;
  }
}
