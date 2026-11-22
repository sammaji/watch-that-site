"use client";

import { DOCS_URL } from "@/lib/links";
import { cn, getAppUrl } from "@watchthatsite/ui/lib/utils";
import Link from "next/link";
import { useState } from "react";
import { Button, buttonVariants } from "./ui/button";

const navLinks = [
    { label: "Home", href: "/", active: true },
    { label: "Docs", href: DOCS_URL, active: false },
];

export function Navbar() {
    const [isMenuOpen, setIsMenuOpen] = useState(false);

    return (
        <header className="bg-theme-dark sticky top-0 z-50 transition-all duration-300">
            <nav>
                <div className="mx-auto max-w-7xl px-6">
                    <div className="flex items-center justify-between py-4">
                        <div>
                            <Link href="/" className="flex gap-1">
                                <img
                                    className="size-8"
                                    alt="WatchThatSite Logo"
                                    src="/logo.svg"
                                />
                                <p className="flex items-center text-center text-xl leading-none font-normal tracking-[-1.5px] text-white">
                                    WatchThatSite
                                </p>
                            </Link>
                        </div>
                        <div className="hidden lg:block">
                            <ul className="flex space-x-8 [&>li>a]:inline-block [&>li>a]:py-4 [&>li>a]:font-normal [&>li>a]:hover:text-white">
                                {navLinks.map(link => (
                                    <li key={link.href}>
                                        <a
                                            className={`${link.active ? "text-white" : "text-white/60"} transition-colors duration-300`}
                                            href={link.href}>
                                            {link.label}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </div>
                        <div className="items-center sm:flex">
                            <div className="hidden lg:flex">
                                <Button
                                    href={getAppUrl("login")}
                                    variant="ghost"
                                    size="nav"
                                    className="hidden sm:inline-flex">
                                    Login
                                </Button>
                                <Button
                                    href={getAppUrl("signup")}
                                    variant="default"
                                    size="nav"
                                    className="tracking-[-0.2px] whitespace-nowrap sm:inline-flex">
                                    Get started
                                </Button>
                            </div>
                            <div className="ml-5 block lg:hidden">
                                <button
                                    type="button"
                                    aria-expanded={isMenuOpen}
                                    aria-controls="mobile-nav"
                                    aria-label="Toggle navigation menu"
                                    className={cn(
                                        buttonVariants({
                                            variant: "plain",
                                            size: "unset",
                                        }),
                                        "text-sm font-medium",
                                    )}
                                    onClick={() =>
                                        setIsMenuOpen(current => !current)
                                    }>
                                    {isMenuOpen ?
                                        <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width={24}
                                            height={24}
                                            viewBox="0 0 24 24"
                                            fill="none">
                                            <path
                                                d="M18 6 6 18M6 6l12 12"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                            />
                                        </svg>
                                    :   <svg
                                            xmlns="http://www.w3.org/2000/svg"
                                            width={24}
                                            height={24}
                                            viewBox="0 0 24 24"
                                            fill="none">
                                            <path
                                                d="M3 12H21M3 6H21M3 18H21"
                                                stroke="currentColor"
                                                strokeWidth={2}
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                            />
                                        </svg>
                                    }
                                </button>
                            </div>
                        </div>
                    </div>
                    {isMenuOpen ?
                        <div
                            id="mobile-nav"
                            className="border-t border-white/20 py-4 lg:hidden">
                            <ul className="space-y-1">
                                {navLinks.map(link => (
                                    <li key={link.href}>
                                        <a
                                            className={`${link.active ? "text-white" : "text-white/60"} block py-3 text-base transition-colors duration-300 hover:text-white`}
                                            href={link.href}
                                            onClick={() =>
                                                setIsMenuOpen(false)
                                            }>
                                            {link.label}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                            <div className="mt-4 grid gap-3 border-t border-white/20 pt-4">
                                <Button
                                    href={getAppUrl("login")}
                                    variant="ghost"
                                    size="full"
                                    onClick={() => setIsMenuOpen(false)}>
                                    Login
                                </Button>
                                <Button
                                    href={getAppUrl("signup")}
                                    variant="default"
                                    size="full"
                                    onClick={() => setIsMenuOpen(false)}>
                                    Get started
                                </Button>
                            </div>
                        </div>
                    :   null}
                </div>
            </nav>
        </header>
    );
}
