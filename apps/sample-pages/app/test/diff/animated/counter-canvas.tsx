"use client";

import { useEffect, useRef } from "react";

/**
 * CounterCanvas draws a counter that ticks on every animation frame. It is
 * pixels only (no DOM text), so it changes screenshots between frames but
 * never the Capture's text blocks.
 */
export function CounterCanvas() {
    const ref = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = ref.current;
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        let frame = 0;
        let handle = 0;
        const draw = () => {
            frame += 1;
            ctx.fillStyle = "#0d1117";
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = "#3fb950";
            ctx.font = "bold 40px Arial, Helvetica, sans-serif";
            ctx.textBaseline = "middle";
            ctx.fillText(String(frame).padStart(6, "0"), 24, canvas.height / 2);
            ctx.fillRect(24 + ((frame * 4) % 240), canvas.height - 16, 40, 8);
            handle = requestAnimationFrame(draw);
        };
        handle = requestAnimationFrame(draw);
        return () => cancelAnimationFrame(handle);
    }, []);

    return (
        <canvas
            ref={ref}
            id="counter-canvas"
            width={320}
            height={96}
            style={{ display: "block", width: 320, height: 96 }}
        />
    );
}
