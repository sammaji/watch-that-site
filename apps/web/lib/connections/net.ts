import "server-only";

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Checks on an address a person typed (a connection's base URL) before the
 * model gateway is told to send their key and requests there.
 *
 * The gateway must not be usable to reach things only our network can see,
 * so only https, and only hosts whose every resolved address is public. The
 * gateway resolves the host again when it connects, so this does not stop a
 * DNS answer that changes later; it stops the plain cases.
 *
 * ALLOW_PRIVATE_NETWORK=true lifts the address and https rules, for local
 * development and tests against a server on this machine.
 */

export type EndpointErrorReason =
    | "invalid_url"
    | "blocked"
    | "dns"
    | "timeout"
    | "tls"
    | "network"
    | "too_large";

/** Why a request could not be made. The message is safe to show: it never holds a key. */
export class EndpointError extends Error {
    readonly reason: EndpointErrorReason;
    constructor(reason: EndpointErrorReason, message: string) {
        super(message);
        this.name = "EndpointError";
        this.reason = reason;
    }
}

export function allowPrivateNetwork(): boolean {
    return process.env.ALLOW_PRIVATE_NETWORK === "true";
}

// Everything that is not a public unicast address: loopback, private,
// link-local (which includes cloud metadata at 169.254.169.254), carrier NAT,
// documentation and multicast ranges. IPv4-mapped IPv6 addresses are checked
// against the IPv4 rules by BlockList itself.
const nonPublic = new BlockList();
for (const [net, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
] as const) {
    nonPublic.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
    ["::", 127], // unspecified and loopback
    ["64:ff9b::", 96], // NAT64: an IPv4 address in disguise
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
] as const) {
    nonPublic.addSubnet(net, prefix, "ipv6");
}

export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 0) return false;
    return !nonPublic.check(address, family === 6 ? "ipv6" : "ipv4");
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal"];

function isLocalName(host: string): boolean {
    return (
        host === "localhost" ||
        LOCAL_SUFFIXES.some(suffix => host.endsWith(suffix))
    );
}

export type VettedUrl = {
    url: URL;
    /** The first address the host resolved to. */
    address: string;
    family: 4 | 6;
};

/**
 * Parses `raw`, resolves its host and checks every address. Throws
 * `EndpointError` when the URL may not be requested.
 */
export async function vetUrl(raw: string): Promise<VettedUrl> {
    const allowPrivate = allowPrivateNetwork();

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new EndpointError(
            "invalid_url",
            "That is not a valid URL. It should look like https://api.example.com/v1.",
        );
    }
    if (
        url.protocol !== "https:" &&
        !(allowPrivate && url.protocol === "http:")
    ) {
        throw new EndpointError(
            "invalid_url",
            "The base URL must start with https://.",
        );
    }
    if (url.username || url.password) {
        throw new EndpointError(
            "invalid_url",
            "The base URL must not contain a user name or password. Put the key in the API key field.",
        );
    }

    const host = url.hostname
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .toLowerCase();
    const blocked = new EndpointError(
        "blocked",
        `${host} is a local or private address, and this server only connects to public ones.`,
    );

    const literal = isIP(host);
    if (literal !== 0) {
        if (!allowPrivate && !isPublicAddress(host)) throw blocked;
        return { url, address: host, family: literal === 6 ? 6 : 4 };
    }
    if (!allowPrivate && isLocalName(host)) throw blocked;

    let addresses: { address: string; family: number }[];
    try {
        addresses = await lookup(host, { all: true });
    } catch {
        addresses = [];
    }
    if (addresses.length === 0) {
        throw new EndpointError(
            "dns",
            `Could not find ${host}. Check the base URL for typos.`,
        );
    }
    // One private answer among public ones is enough to refuse: which one a
    // later connection would use is not ours to choose.
    if (!allowPrivate && !addresses.every(a => isPublicAddress(a.address))) {
        throw blocked;
    }
    const first = addresses[0]!;
    return { url, address: first.address, family: first.family === 6 ? 6 : 4 };
}
