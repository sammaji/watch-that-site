import { faker } from "@faker-js/faker";

/** Takes a timestamp and returns a unique seed value that is unqiue for the
 * given calendar aligned interval. Used to deterministically generate fake
 * data that changes after the given interval.
 */
export function bucket(now = Date.now(), intervalMs: number): number {
    return Math.floor(now / intervalMs);
}

/** Deterministic hash of arbitrary seed inputs into a 32-bit unsigned int. */
export function hashSeed(...parts: Array<number | string>): number {
    const str = parts.join(":");
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

export const Time = {
    SECOND: 1000,
    MINUTE: 60 * 1000,
    HOUR: 60 * 60 * 1000,
    DAY: 24 * 60 * 60 * 1000,
};

const STABLE_SEED = 69;

// === BLOG PAGE ===
export function getColor(refreshIntervalMs = Time.HOUR): string {
    const now = Date.now();
    const b = bucket(now, refreshIntervalMs);
    const COLORS = ["#ef4444", "#3b82f6", "#22c55e", "#eab308"] as const;
    return COLORS[b % COLORS.length];
}

type ParagraphType = "stable" | "volatile";

/** Paragraph that fully rewrites (volatile) or swaps a handful of words
 * (stable), word count held constant.
 */
export function getParagraph(
    type: ParagraphType = "stable",
    refreshIntervalMs = Time.HOUR,
): string {
    const now = Date.now();
    faker.seed(bucket(now, refreshIntervalMs));
    const words = faker.lorem.words(90);

    faker.seed(STABLE_SEED);
    if (type === "volatile") {
        return words;
    }

    const stableWords = faker.lorem.words(90).split(" ");
    for (let i = 0; i < 3; i++) {
        const replacementIdx = faker.number.int({
            min: 0,
            max: stableWords.length - 1,
        });
        const selectionIdx = faker.number.int({
            min: 0,
            max: words.length - 1,
        });
        stableWords[replacementIdx] = words[selectionIdx];
    }
    return stableWords.join(" ");
}

// === CAREERS PAGE ===
export const CATEGORIES = [
    "Engineering",
    "Design",
    "Sales",
    "Marketing",
    "Operations",
] as const;

export type JobPost = {
    id: string;
    title: string;
    category: string;
    location: string;
    description: string;
};

export function getJobPosts(refreshIntervalMs = Time.DAY): JobPost[] {
    const now = Date.now();
    faker.seed(bucket(now, refreshIntervalMs));
    return Array.from({ length: 30 }, (_, i) => {
        const categoryIdx = faker.number.int({
            min: 0,
            max: CATEGORIES.length - 1,
        });
        const id = `job-${i}`;
        const category = CATEGORIES[categoryIdx];
        const location = faker.location.city();
        const description = faker.lorem.sentences(2);
        const title = faker.person.jobTitle();
        return {
            id,
            title,
            category,
            location,
            description,
        };
    });
}

// === SHOP PAGE ===
const PRODUCT_COUNT = 6;

export type Product = {
    id: string;
    name: string;
    description: string;
    image: string;
    units: number;
    comments: string[];
};

let cachedCatalog: Product[] | null = null;

export function getCatalog(): Product[] {
    if (cachedCatalog) {
        return cachedCatalog;
    }

    faker.seed(STABLE_SEED);
    cachedCatalog = Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
        id: `product-${i}`,
        name: faker.commerce.productName(),
        description: faker.commerce.productDescription(),
        image: `https://picsum.photos/seed/product-${i}/400/300`,
        units: faker.number.int({ min: 0, max: 250 }),
        comments: Array.from({ length: 3 }, () => faker.lorem.sentence()),
    }));

    return cachedCatalog;
}

export function getPrice(
    productId: string,
    now = Date.now(),
    refreshIntervalMs = Time.MINUTE,
): number {
    faker.seed(hashSeed(productId, bucket(now, refreshIntervalMs)));
    return faker.number.float({ min: 9.99, max: 199.99, fractionDigits: 2 });
}

export function isCheckoutDisabled(
    now = Date.now(),
    refreshIntervalMs = Time.HOUR,
): boolean {
    return bucket(now, refreshIntervalMs) % 2 === 0;
}

// === FINANCE PAGE ===
const financeSeeds = [
    {
        name: "Aster Capital",
        country: { code: "US", label: "United States" },
        creator: "Ava Carter",
        currency: "USD",
        amountRange: { min: 100_000, max: 150_000 },
    },
    {
        name: "Monsoon Retail",
        country: { code: "IN", label: "India" },
        creator: "Rohan Mehta",
        currency: "INR",
        amountRange: { min: 700_000, max: 900_000 },
    },
    {
        name: "Northwind Labs",
        country: { code: "EU", label: "European Union" },
        creator: "Lena Fischer",
        currency: "EUR",
        amountRange: { min: 50_000, max: 80_000 },
    },
    {
        name: "Blue Harbor Pay",
        country: { code: "IN", label: "India" },
        creator: "Nisha Rao",
        currency: "INR",
        amountRange: { min: 250_000, max: 400_000 },
    },
    {
        name: "Summit Metrics",
        country: { code: "US", label: "United States" },
        creator: "Mason Lee",
        currency: "USD",
        amountRange: { min: 80_000, max: 110_000 },
    },
    {
        name: "Orbital Commerce",
        country: { code: "EU", label: "European Union" },
        creator: "Clara Weber",
        currency: "EUR",
        amountRange: { min: 55_000, max: 75_000 },
    },
] as const;

export type FinanceRow = {
    name: string;
    amount: string;
    profit: number;
    trend: number[];
    country: {
        code: "IN" | "EU" | "US";
        label: string;
    };
    creator: string;
};

export function getFinanceRows(
    now = Date.now(),
    {
        amountRefreshIntervalMs = Time.HOUR,
        profitRefreshIntervalMs = 15 * Time.MINUTE,
    }: {
        amountRefreshIntervalMs?: number;
        profitRefreshIntervalMs?: number;
    } = {},
): FinanceRow[] {
    return financeSeeds.map((seed, index) => {
        faker.seed(
            hashSeed(
                "finance-amount",
                index,
                bucket(now, amountRefreshIntervalMs),
            ),
        );
        const amount = faker.number.int(seed.amountRange);

        faker.seed(
            hashSeed(
                "finance-profit",
                index,
                bucket(now, profitRefreshIntervalMs),
            ),
        );
        const profit = faker.number.float({
            min: -4.5,
            max: 18.5,
            fractionDigits: 1,
        });

        return {
            ...seed,
            amount: formatAmount(amount, seed.currency),
            profit,
            trend: getTrend(index, profit, now, profitRefreshIntervalMs),
        };
    });
}

function getTrend(
    index: number,
    profit: number,
    now: number,
    refreshIntervalMs: number,
): number[] {
    faker.seed(
        hashSeed("finance-trend", index, bucket(now, refreshIntervalMs)),
    );

    const start = faker.number.int({ min: 14, max: 40 });
    const direction = profit >= 0 ? 1 : -1;
    let point = start;

    return Array.from({ length: 7 }, (_, step) => {
        if (step > 0) {
            point += faker.number.int({ min: 1, max: 6 }) * direction;
        }

        return point;
    });
}

function formatAmount(amount: number, currency: string): string {
    const locale =
        currency === "INR" ? "en-IN"
        : currency === "EUR" ? "de-DE"
        : "en-US";

    return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        maximumFractionDigits: 0,
    }).format(amount);
}
