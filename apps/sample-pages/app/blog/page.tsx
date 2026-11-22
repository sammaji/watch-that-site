import { getColor, getParagraph } from "@/lib/faker";
import { blogPageParams, type SearchParams } from "@/lib/refresh-params";

export const dynamic = "force-dynamic";

export default async function BlogPage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    const { contentRefreshInterval, colorRefreshInterval } =
        await blogPageParams(searchParams);

    const volatileParagraph = getParagraph("volatile", contentRefreshInterval);
    const stableParagraph = getParagraph("stable", contentRefreshInterval);
    const color = getColor(colorRefreshInterval);

    return (
        <main className="mx-auto max-w-2xl space-y-6 p-8">
            <h1 className="text-2xl font-semibold">Daily Digest</h1>
            <p className="text-sm text-gray-500" data-testid="current-time">
                Current time: {new Date().toISOString()}
            </p>

            <p data-testid="volatile-paragraph">{volatileParagraph}</p>
            <p data-testid="stable-paragraph">{stableParagraph}</p>

            <button
                type="button"
                data-testid="color-button"
                style={{ backgroundColor: color }}
                className="rounded-md px-4 py-2 font-medium text-white">
                Subscribe
            </button>
        </main>
    );
}
