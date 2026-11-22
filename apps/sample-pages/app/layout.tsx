import { getSiteUrl } from "@watchthatsite/ui/lib/utils";
import "@watchthatsite/ui/styles.css";
import type { Metadata } from "next";
import "./globals.css";

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

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body className="antialiased">{children}</body>
        </html>
    );
}
