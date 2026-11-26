import { PondEngine } from "./src";
import { koiFromQuery } from "./pages/query";

// ?koi=kohaku,showa,butterfly-ogon — first is biggest, the rest step down. No param: a mixed pond of four.
new PondEngine(document.querySelector("canvas")!, koiFromQuery());
