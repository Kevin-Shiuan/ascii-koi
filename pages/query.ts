import type { KoiKind, KoiSpec } from "../src";

/**
 * ?koi=kohaku,showa,butterfly-ogon — first is biggest, the rest step down.
 * A `butterfly-` prefix gives that koi long, flowing fins.
 */
export function koiFromQuery(): KoiSpec[] | undefined {
  const names = new URLSearchParams(location.search).get("koi")?.split(",").filter(Boolean);
  return names?.map((name, i) => {
    const long = name.startsWith("butterfly-");
    return { kind: (long ? name.slice("butterfly-".length) : name) as KoiKind, size: 1 - i * 0.1, fins: long ? "long" : "short" };
  });
}

export const flag = (name: string) => new URLSearchParams(location.search).has(name);

/**
 * The chat hero scene: a mixed pond of seven, two of them butterfly koi trailing long fins.
 * Sizes stay small enough that all seven fit, and the chat pages keep them all in frame.
 */
export const HERO_KOI: KoiSpec[] = [
  { kind: "kohaku", size: 1.05 },
  { kind: "showa", size: 0.95 },
  { kind: "ogon", size: 0.9, fins: "long" },
  { kind: "sanke", size: 0.86 },
  { kind: "tancho", size: 0.82 },
  { kind: "asagi", size: 0.78 },
  { kind: "platinum", size: 0.74, fins: "long" },
];

/** Every variety once (?all), sized so the big ones read as nearer the surface. */
export const ALL_KOI: KoiSpec[] = [
  { kind: "kohaku", size: 1.2 },
  { kind: "sanke", size: 1.1 },
  { kind: "showa", size: 1.05 },
  { kind: "tancho", size: 1 },
  { kind: "utsuri", size: 0.95 },
  { kind: "ogon", size: 0.9, fins: "long" },
  { kind: "platinum", size: 0.85 },
  { kind: "kigoi", size: 0.82 },
  { kind: "chagoi", size: 0.8 },
  { kind: "asagi", size: 0.76 },
  { kind: "shusui", size: 0.72 },
];
