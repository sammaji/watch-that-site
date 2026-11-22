import createMDX from "@next/mdx";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
    pageExtensions: ["js", "jsx", "mdx", "ts", "tsx"],
    serverExternalPackages: ["@takumi-rs/image-response"],
    images: {
        unoptimized: true,
    },
    async rewrites() {
        return [
            {
                source: "/docs/:slug*",
                destination: process.env.NEXT_PUBLIC_DOC_URL + "/docs/:slug*",
            },
        ];
    },
};
const withMDX = createMDX({
    options: {
        remarkPlugins: [],
        rehypePlugins: [],
    },
});

export default withMDX(nextConfig);
