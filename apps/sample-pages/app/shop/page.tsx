import {
    getCatalog,
    getPrice,
    isCheckoutDisabled,
    Time,
} from "@/lib/faker";
import {
    shopPageParams,
    toPositiveInterval,
    type SearchParams,
} from "@/lib/refresh-params";

import { ShopClient } from "./shop-client";

export const dynamic = "force-dynamic";

export default async function ShopPage({
    searchParams,
}: {
    searchParams: SearchParams;
}) {
    // eslint-disable-next-line react-hooks/purity -- intentionally impure: page is force-dynamic and time-driven
    const now = Date.now();
    const { priceRefreshInterval, checkoutRefreshInterval } =
        await shopPageParams(searchParams);
    const priceRefreshIntervalMs = toPositiveInterval(
        priceRefreshInterval,
        Time.MINUTE,
    );
    const checkoutRefreshIntervalMs = toPositiveInterval(
        checkoutRefreshInterval,
        Time.HOUR,
    );
    const products = getCatalog().map(product => ({
        ...product,
        price: getPrice(product.id, now, priceRefreshIntervalMs),
    }));

    return (
        <ShopClient
            products={products}
            checkoutDisabled={isCheckoutDisabled(
                now,
                checkoutRefreshIntervalMs,
            )}
            now={now}
        />
    );
}
