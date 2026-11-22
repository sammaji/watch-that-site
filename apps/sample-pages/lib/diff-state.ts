/**
 * Server-side variant state for the diffing E2E fixtures under
 * `/test/diff/*`. A Monitor's URL stays fixed while tests flip the variant
 * through `/test/api/diff-state`.
 *
 * The map lives on `globalThis` so Next dev (HMR, and route handlers and pages
 * compiled into separate module graphs) shares one copy per process.
 */

export const DIFF_SCENARIOS = {
    pricing: ["v1", "v2", "v3", "e1", "e2", "e3", "e4", "e5"],
    volatile: ["v1"],
    list: ["v1", "v2", "v3"],
    cookie: ["v1", "v2"],
    shift: ["v1", "v2", "v3"],
    ab: ["a", "b"],
    status: ["ok", "503", "challenge", "empty", "partial"],
    element: ["v1", "v2", "v3", "v4"],
    lazy: ["v1", "v2"],
    animated: ["v1"],
    data: ["v1", "v2", "v3"],
    ignored: ["v1", "v2"],
    flap: ["a", "b"],
    // A storefront with a hero image, plan prices and a testimonial that
    // rotates on every load: v2 raises a price, v3 swaps the hero image only,
    // v4 is v2 with a fourth plan added.
    storefront: ["v1", "v2", "v3", "v4"],
    // An account area behind a sign-in: v2 raises the annual price, `renamed`
    // keeps v2's price and renames the Billing tab (so a recorded Macro step
    // stops matching by name).
    account: ["v1", "v2", "renamed"],
} as const satisfies Record<string, readonly string[]>;

export type DiffScenario = keyof typeof DIFF_SCENARIOS;
export type DiffVariant<S extends DiffScenario> =
    (typeof DIFF_SCENARIOS)[S][number];

type DiffStateStore = {
    variants: Map<string, string>;
    /** Per-key scratch values fixtures may keep between requests. */
    scratch: Map<string, unknown>;
};

const globalStore = globalThis as typeof globalThis & {
    __watchthatsiteDiffState?: DiffStateStore;
};

function store(): DiffStateStore {
    if (!globalStore.__watchthatsiteDiffState) {
        globalStore.__watchthatsiteDiffState = {
            variants: new Map(),
            scratch: new Map(),
        };
    }
    return globalStore.__watchthatsiteDiffState;
}

export function isDiffScenario(value: unknown): value is DiffScenario {
    return typeof value === "string" && Object.hasOwn(DIFF_SCENARIOS, value);
}

export function isVariantOf(scenario: DiffScenario, variant: unknown) {
    return (
        typeof variant === "string" &&
        (DIFF_SCENARIOS[scenario] as readonly string[]).includes(variant)
    );
}

/** getVariant returns the scenario's current variant, or its first variant. */
export function getVariant<S extends DiffScenario>(
    scenario: S,
): DiffVariant<S> {
    const current = store().variants.get(scenario);
    if (current && isVariantOf(scenario, current)) {
        return current as DiffVariant<S>;
    }
    return DIFF_SCENARIOS[scenario][0] as DiffVariant<S>;
}

export function setVariant(scenario: DiffScenario, variant: string) {
    if (!isVariantOf(scenario, variant)) {
        throw new Error(
            `Unknown variant ${variant} for scenario ${scenario}; expected one of ${DIFF_SCENARIOS[scenario].join(", ")}`,
        );
    }
    store().variants.set(scenario, variant);
}

export function resetDiffState() {
    store().variants.clear();
    store().scratch.clear();
}

export function getScratch<T>(key: string): T | undefined {
    return store().scratch.get(key) as T | undefined;
}

export function setScratch(key: string, value: unknown) {
    store().scratch.set(key, value);
}

/** snapshotDiffState returns every scenario's current variant. */
export function snapshotDiffState(): Record<DiffScenario, string> {
    const out = {} as Record<DiffScenario, string>;
    for (const scenario of Object.keys(DIFF_SCENARIOS) as DiffScenario[]) {
        out[scenario] = getVariant(scenario);
    }
    return out;
}
