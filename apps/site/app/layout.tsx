import { DM_Sans, Inter } from "next/font/google";

import type { Metadata } from "next";

import { CTA } from "@/components/cta";
import { Footer } from "@/components/footer";
import { Navbar } from "@/components/navbar";
import { ThemeProvider } from "@/components/theme-provider";
import "@watchthatsite/ui/styles.css";
import "./globals.css";

const dmSans = DM_Sans({
    subsets: ["latin"],
    variable: "--font-dm-sans",
    display: "swap",
});

const inter = Inter({
    subsets: ["latin"],
    variable: "--font-inter",
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
                url: "/og-image.jpg",
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
        images: ["/og-image.jpg"],
    },
};

export default function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" suppressHydrationWarning>
            <body
                className={`${dmSans.variable} ${inter.variable} bg-theme-dark antialiased`}>
                <ThemeProvider
                    attribute="class"
                    defaultTheme="light"
                    enableSystem
                    disableTransitionOnChange>
                    <main>
                        <Navbar />
                        {children}
                        <CTA />
                        <Footer />
                    </main>
                </ThemeProvider>
            </body>
        </html>
    );
}
