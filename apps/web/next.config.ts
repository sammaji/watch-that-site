import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "..", ".."),
    transpilePackages: [
        "@watchthatsite/auth",
        "@watchthatsite/db",
        "@watchthatsite/ui",
    ],
    turbopack: {
        root: path.join(__dirname, "..", ".."),
    },
};

export default nextConfig;
