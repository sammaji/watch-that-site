import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
    // The dev-mode indicator is position: fixed, so it would appear in every
    // full-page screenshot of the diff fixtures at a different place relative
    // to the content.
    devIndicators: false,
    transpilePackages: ["@watchthatsite/ui"],
    images: {
        remotePatterns: [{ protocol: "https", hostname: "picsum.photos" }],
    },
    turbopack: {
        root: path.join(__dirname, "..", ".."),
    },
};

export default nextConfig;
