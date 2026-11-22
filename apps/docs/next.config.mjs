import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
    basePath: "/docs",
    serverExternalPackages: ["@takumi-rs/image-response"],
    reactStrictMode: true,
    async redirects() {
        return [
            {
                source: "/",
                destination: "/docs",
                basePath: false,
                permanent: false,
            },
        ];
    },
    async rewrites() {
        return [
            {
                source: "/:path*.md",
                destination: "/api/md/:path*",
            },
        ];
    },
};

export default withMDX(config);
