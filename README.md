# ascii koi

```
                  .-""-.
                .' .::. '.
          .::;;==+++++==;;::.                            .;
     .:;==+xx**xxx++++xx**xx++==;;::..                .;=x'
   .;=o*%%x+==;;;;;;;;;;==++xx**%%xx++==;;::......:;=+x%=
  (:=*%%#######################################%x+=;:
   ':=o*%%x+==;;;;;;;;;;==++xx**%%xx++==;;::'''''':;=+x%=
     ':;==+xx**xxx++++xx**xx++==;;::''                ':=x.
          '::;;==+++++==;;::'                            ':
                '. '::' .'
                  '-..-'
```

A koi pond drawn as ASCII on a canvas. Schools of small fish weave between the koi, and a click drops food. Zero dependencies.

Eleven varieties share one body and differ only in pattern: kohaku, tancho, taisho sanke, showa, shiro utsuri, ogon, platinum ogon, kigoi, chagoi, asagi and shusui. Any of them can be a butterfly koi with long, flowing fins.

```sh
npm install && npm run dev
```

```ts
import { PondEngine } from "./src";

const engine = new PondEngine(canvas, [{ kind: "kohaku", size: 1 }, { kind: "ogon", size: 0.9, fins: "long" }]);

// Options: fish count (0 = koi only), "dark" | "light" theme, a drawing stage
// ("spine" | "silhouette" | "shaded" | "full"), pointer on/off, a single still frame,
// contain: true to keep every koi wholly inside the canvas, and feed: false to stop
// the keeper scattering food now and then.
new PondEngine(canvas, undefined, { theme: "light", fish: 0, pointer: false, still: true });
```

Click the water to drop a pinch of food. Hungry koi turn for the pellet that is cheapest to reach, close and ahead rather than behind, and gulp it down, which leaves a ring on the water.

Routes:

```
/            the demo
/light       the chat hero scene, on paper
/dark        the chat hero scene, on black
/blueprints  ten frames on one grid, from Conway's Life to the koi
```

`?koi=kohaku,showa,butterfly-ogon` picks the cast on any koi page (a `butterfly-` prefix gives that koi long fins), `?all` puts every variety in, and `?still=1` draws one settled frame.

A fork of [stackedlol/ascii-sharks](https://github.com/stackedlol/ascii-sharks), which drew the same ocean with sharks. MIT, original copyright notice kept in [LICENSE](LICENSE).
