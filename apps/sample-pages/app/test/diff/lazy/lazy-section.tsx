"use client";

import { useEffect, useRef, useState } from "react";

/**
 * LazySection renders its text only once it scrolls into view, like a
 * lazy-loaded widget. A Capture that never scrolls sees an empty box.
 */
export function LazySection({ text }: { text: string }) {
    const ref = useRef<HTMLDivElement>(null);
    const [visible, setVisible] = useState(false);

    useEffect(() => {
        const node = ref.current;
        if (!node) return;
        const observer = new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) {
                setVisible(true);
                observer.disconnect();
            }
        });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);

    return (
        <div
            ref={ref}
            id="lazy-section"
            data-loaded={visible ? "true" : "false"}
            style={{
                height: 160,
                padding: 16,
                border: "2px dashed #8250df",
                borderRadius: 6,
            }}
        >
            {visible ?
                <p id="lazy-text" style={{ margin: 0 }}>
                    {text}
                </p>
            :   null}
        </div>
    );
}
