import { getVariant } from "@/lib/diff-state";
import type { Metadata } from "next";
import { Fixture, h1Style } from "../_components/fixture";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "List fixture" };

const ITEMS: Record<string, string> = {
    A: "Item A: Alder coffee grinder",
    B: "Item B: Birch cutting board",
    C: "Item C: Cedar spice rack",
    D: "Item D: Driftwood serving tray",
    E: "Item E: Elm salad bowl",
    F: "Item F: Fir bread box",
    G: "Item G: Gum wood utensil set",
    H: "Item H: Hazel knife block",
    I: "Item I: Ironwood pepper mill",
    J: "Item J: Juniper coaster set",
    K: "Item K: Koa wood cheese board",
};

// v2 is v1 reordered (same items, same text); v3 is v2 plus item K.
const ORDER: Record<string, string[]> = {
    v1: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
    v2: ["C", "A", "B", "F", "D", "E", "J", "G", "H", "I"],
    v3: ["C", "A", "B", "F", "D", "E", "J", "G", "H", "I", "K"],
};

export default function ListFixture() {
    const variant = getVariant("list");
    return (
        <Fixture scenario="list" variant={variant}>
            <h1 style={h1Style}>Kitchen catalogue</h1>
            <ul id="items" style={{ margin: 0, padding: 0 }}>
                {ORDER[variant].map(key => (
                    <li
                        key={key}
                        id={`item-${key.toLowerCase()}`}
                        style={{
                            listStyle: "none",
                            height: 40,
                            margin: "0 0 6px",
                            padding: "8px 12px",
                            border: "1px solid #d0d7de",
                            borderRadius: 4,
                        }}
                    >
                        {ITEMS[key]}
                    </li>
                ))}
            </ul>
        </Fixture>
    );
}
