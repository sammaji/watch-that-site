import { getSiteUrl } from "@watchthatsite/ui/lib/utils";
import { RootProvider } from "fumadocs-ui/provider/next";
import { Metadata } from "next";
import { Inter } from "next/font/google";
import "./global.css";

const inter = Inter({
    subsets: ["latin"],
});

const appName = "WatchThatSite";
const title = "Track changes in any website";
const description =
    "Monitor changes in any website, and get notified when something changes.";

export const metadata: Metadata = {
    title: {
        default: title,
        template: "%s | WatchThatSite",
    },
    description,
    keywords: [
        "website monitoring",
        "website change alerts",
        "page monitoring",
        "change detection",
        "web page tracker",
    ],
    authors: [{ name: appName }],
    creator: appName,
    publisher: appName,
    robots: {
        index: true,
        follow: true,
    },
    manifest: "/site.webmanifest",
    icons: {
        icon: [
            { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
            { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
        ],
        apple: [
            {
                url: "/apple-touch-icon.png",
                sizes: "180x180",
                type: "image/png",
            },
        ],
    },
    openGraph: {
        title,
        description,
        siteName: appName,
        images: [
            {
                url: getSiteUrl("og-image.jpg"),
                width: 1200,
                height: 630,
                alt: title,
            },
        ],
    },
    twitter: {
        card: "summary_large_image",
        title,
        description,
        images: [getSiteUrl("og-image.jpg")],
    },
};

export default function Layout({ children }: LayoutProps<"/">) {
    return (
        <html lang="en" className={inter.className} suppressHydrationWarning>
            <body className="flex min-h-screen flex-col">
                <RootProvider>{children}</RootProvider>
            </body>
        </html>
    );
}
