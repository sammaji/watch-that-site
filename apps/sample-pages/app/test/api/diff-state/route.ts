import {
    DIFF_SCENARIOS,
    getVariant,
    isDiffScenario,
    isVariantOf,
    resetDiffState,
    setVariant,
    snapshotDiffState,
} from "@/lib/diff-state";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

/** GET ?scenario= returns one scenario's variant; without it, all of them. */
export async function GET(request: NextRequest) {
    const scenario = request.nextUrl.searchParams.get("scenario");
    if (scenario === null) {
        return NextResponse.json(
            { variants: snapshotDiffState(), scenarios: DIFF_SCENARIOS },
            { headers: noStore },
        );
    }
    if (!isDiffScenario(scenario)) {
        return NextResponse.json(
            { error: `unknown scenario ${scenario}` },
            { status: 404, headers: noStore },
        );
    }
    return NextResponse.json(
        { scenario, variant: getVariant(scenario) },
        { headers: noStore },
    );
}

/** POST {scenario, variant} sets a scenario's variant. */
export async function POST(request: NextRequest) {
    let body: unknown;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json(
            { error: "body must be JSON {scenario, variant}" },
            { status: 400, headers: noStore },
        );
    }
    const { scenario, variant } = (body ?? {}) as {
        scenario?: unknown;
        variant?: unknown;
    };
    if (!isDiffScenario(scenario)) {
        return NextResponse.json(
            { error: `unknown scenario ${String(scenario)}` },
            { status: 404, headers: noStore },
        );
    }
    if (!isVariantOf(scenario, variant)) {
        return NextResponse.json(
            {
                error: `unknown variant ${String(variant)} for ${scenario}`,
                variants: DIFF_SCENARIOS[scenario],
            },
            { status: 400, headers: noStore },
        );
    }
    setVariant(scenario, variant as string);
    return NextResponse.json({ scenario, variant }, { headers: noStore });
}

/** DELETE resets every scenario to its first variant. */
export async function DELETE() {
    resetDiffState();
    return NextResponse.json({ variants: snapshotDiffState() }, { headers: noStore });
}
