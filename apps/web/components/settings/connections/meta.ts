import type { ProviderConnection } from "@watchthatsite/types";

/** A model id as the owner knows it, without the gateway provider in front. */
export function displayModel(
    connection: ProviderConnection,
    model: string,
): string {
    const prefix = `${connection.gateway_provider}/`;
    return model.startsWith(prefix) ? model.slice(prefix.length) : model;
}

/** A model id the owner typed, as the gateway routes it. */
export function gatewayModel(
    connection: ProviderConnection,
    model: string,
): string {
    const prefix = `${connection.gateway_provider}/`;
    return model.startsWith(prefix) ? model : `${prefix}${model}`;
}

export function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
}
