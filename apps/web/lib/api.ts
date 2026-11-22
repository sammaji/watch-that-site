export const API_BASE_PATH = "/api/v1";

export type PageMetadata = {
    url: string;
    title?: string;
    description?: string;
    image?: string;
    favicon?: string;
};

export async function fetchUrlMetadata(
    targetUrl: string,
    signal?: AbortSignal,
): Promise<PageMetadata> {
    const qs = new URLSearchParams({ url: targetUrl });
    const response = await fetch(`${API_BASE_PATH}/metadata?${qs}`, {
        cache: "no-store",
        signal,
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(text || `metadata fetch failed: ${response.status}`);
    }
    return (await response.json()) as PageMetadata;
}
