import { getVariant } from "@/lib/diff-state";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Item = { id: string; name: string; price: number; stock: number };

const ITEMS: Item[] = [
    { id: "sku-100", name: "Alder coffee grinder", price: 45, stock: 12 },
    { id: "sku-200", name: "Birch cutting board", price: 30, stock: 40 },
    { id: "sku-300", name: "Cedar spice rack", price: 25, stock: 7 },
    { id: "sku-400", name: "Driftwood serving tray", price: 60, stock: 3 },
    { id: "sku-500", name: "Elm salad bowl", price: 38, stock: 19 },
];

function itemsFor(variant: string): Item[] {
    switch (variant) {
        case "v2":
            // Only items[2].price changes.
            return ITEMS.map((item, i) => (i === 2 ? { ...item, price: 29 } : item));
        case "v3":
            // Same items (same ids and values), different order.
            return [ITEMS[3], ITEMS[0], ITEMS[4], ITEMS[2], ITEMS[1]];
        default:
            return ITEMS;
    }
}

export async function GET() {
    const variant = getVariant("data");
    return NextResponse.json(
        { store: "Acme Kitchen", currency: "USD", items: itemsFor(variant) },
        { headers: { "cache-control": "no-store", "x-fixture-variant": variant } },
    );
}
