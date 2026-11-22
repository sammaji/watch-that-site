export function avatarUrl(src?: string | undefined | null): string {
    const fallbackUrl = "/images/avatar.svg";
    if (!src) return fallbackUrl;
    if (typeof src === "string" && src.length === 0) return fallbackUrl;
    return src;
}

// defaultNull is a helper to return null if the value is undefined or null.
// reason: for most of our queries we return T | null, but in many cases, like
// output from react-query, we get undefined instead of null.
export function defaultNull<T>(value: T | undefined): T | null {
    if (typeof value === "undefined" || value === null) {
        return null;
    }
    return value;
}
