import { createLoader, parseAsInteger } from "nuqs/server";
import { Time } from "./faker";

export type SearchParams = Promise<
    Record<string, string | string[] | undefined>
>;

export function toPositiveInterval(intervalMs: number, fallbackMs: number): number {
    return Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : fallbackMs;
}

export const blogPageParams = createLoader(
    {
        contentRefreshInterval: parseAsInteger.withDefault(Time.HOUR),
        colorRefreshInterval: parseAsInteger.withDefault(15 * Time.MINUTE),
    },
    {
        urlKeys: {
            contentRefreshInterval: "content_refresh_interval",
            colorRefreshInterval: "color_refresh_interval",
        },
    },
);

export const careersPageParams = createLoader(
    {
        titleRefreshInterval: parseAsInteger.withDefault(Time.DAY),
    },
    {
        urlKeys: {
            titleRefreshInterval: "title_refresh_interval",
        },
    },
);

export const shopPageParams = createLoader(
    {
        priceRefreshInterval: parseAsInteger.withDefault(Time.MINUTE),
        checkoutRefreshInterval: parseAsInteger.withDefault(Time.HOUR),
    },
    {
        urlKeys: {
            priceRefreshInterval: "price_refresh_interval",
            checkoutRefreshInterval: "checkout_refresh_interval",
        },
    },
);

export const financePageParams = createLoader(
    {
        amountRefreshInterval: parseAsInteger.withDefault(Time.HOUR),
        profitRefreshInterval: parseAsInteger.withDefault(15 * Time.MINUTE),
    },
    {
        urlKeys: {
            amountRefreshInterval: "amount_refresh_interval",
            profitRefreshInterval: "profit_refresh_interval",
        },
    },
);
