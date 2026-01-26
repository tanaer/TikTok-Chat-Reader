"use client";

import Link from "next/link";
import { useState, useEffect } from "react";

export function Navbar() {
    const [scrolled, setScrolled] = useState(false);

    useEffect(() => {
        const handleScroll = () => setScrolled(window.scrollY > 20);
        window.addEventListener("scroll", handleScroll);
        return () => window.removeEventListener("scroll", handleScroll);
    }, []);

    return (
        <nav className={`fixed top-4 left-4 right-4 z-50 px-6 py-3 rounded-2xl transition-all duration-200 ${scrolled ? "glass shadow-lg" : "bg-transparent"
            }`}>
            <div className="max-w-7xl mx-auto flex items-center justify-between">
                <Link href="/" className="flex items-center gap-2 text-xl font-bold cursor-pointer">
                    {/* Logo SVG - Analytics icon */}
                    <svg className="w-8 h-8 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
                        <path d="M18 9l-5 5-4-4-3 3" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="text-white">TikTok <span className="text-blue-400">Monitor</span></span>
                </Link>

                <div className="hidden md:flex items-center gap-8">
                    <a href="#features" className="nav-link">功能</a>
                    <a href="#pricing" className="nav-link">定价</a>
                    <a href="#faq" className="nav-link">常见问题</a>
                </div>

                <div className="flex items-center gap-4">
                    <Link href="/login" className="nav-link px-4 py-2">
                        登录
                    </Link>
                    <Link href="/register" className="btn-cta px-6 py-2 rounded-lg">
                        免费试用
                    </Link>
                </div>
            </div>
        </nav>
    );
}
