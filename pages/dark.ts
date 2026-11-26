import { PondEngine } from "../src";
import { ALL_KOI, flag, HERO_KOI, koiFromQuery } from "./query";

// The chat hero scene, on the dark pond: koi circling, small fish, the cursor
// scattering them, and a soft pool kept clear in the middle. ?all puts every variety in; ?still=1 draws one frame.
new PondEngine(document.querySelector("canvas")!, koiFromQuery() ?? (flag("all") ? ALL_KOI : HERO_KOI), {
  theme: "dark",
  contain: true,
  still: flag("still"),
});
