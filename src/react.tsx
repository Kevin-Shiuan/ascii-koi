"use client";

import { useEffect, useRef } from "react";
import { PondEngine } from "./engine";
import type { KoiSpec } from "./world";

/** Glyphs come from the canvas's font-family, so give it (or a parent) a monospace font. */
export function AsciiPond({ className, koi }: { className?: string; koi?: KoiSpec[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new PondEngine(canvas, koi);
    return () => engine.destroy();
    // The roster is fixed for the life of the canvas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" className={`ascii-pond ${className ?? ""}`} />;
}
