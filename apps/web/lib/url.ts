/**
 * Changes the query string of the current page without a server round trip.
 *
 * `router.replace` re-renders the route on the server. On a page that is
 * already loaded that only costs time, and while it is in flight the click
 * that caused it does not show (a tab stays on the old one) and a server
 * action started meanwhile can be cancelled. Next.js keeps
 * `useSearchParams` in sync with `window.history.replaceState`, so state
 * kept in the URL (the open tab, a one-off `?feedback=` flag) is updated
 * this way instead.
 */
export function replaceQuery(
    pathname: string,
    update: (params: URLSearchParams) => void,
) {
    const params = new URLSearchParams(window.location.search);
    update(params);
    const qs = params.toString();
    // `null`, not the current state: Next.js syncs its router only for a
    // state it did not write itself.
    window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
}
