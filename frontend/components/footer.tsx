import Link from "next/link";

export function Footer() {
    return (
        <footer className="border-t border-white/10 pt-16 pb-8 px-8">
            <div className="max-w-7xl mx-auto">
                <div className="grid md:grid-cols-[2fr_3fr] gap-12 mb-12">
                    <div>
                        <Link href="/" className="flex items-center gap-2 text-xl font-bold mb-4 cursor-pointer">
                            {/* Logo SVG */}
                            <svg className="w-8 h-8 text-blue-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M18 9l-5 5-4-4-3 3" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                            <span className="text-white">TikTok <span className="text-blue-400">Monitor</span></span>
                        </Link>
                        <p className="text-slate-500 text-sm">专业的直播数据分析平台</p>
                    </div>

                    <div className="grid grid-cols-3 gap-8">
                        <div>
                            <h4 className="text-sm text-slate-500 font-medium mb-4 uppercase tracking-wider">产品</h4>
                            <div className="space-y-3">
                                <a href="#features" className="block text-sm text-slate-300 hover:text-blue-400 transition cursor-pointer">功能介绍</a>
                                <a href="#pricing" className="block text-sm text-slate-300 hover:text-blue-400 transition cursor-pointer">定价</a>
                                <Link href="/login" className="block text-sm text-slate-300 hover:text-blue-400 transition">控制台</Link>
                            </div>
                        </div>
                        <div>
                            <h4 className="text-sm text-slate-500 font-medium mb-4 uppercase tracking-wider">支持</h4>
                            <div className="space-y-3">
                                <a href="#faq" className="block text-sm text-slate-300 hover:text-blue-400 transition cursor-pointer">常见问题</a>
                                <a href="mailto:support@example.com" className="block text-sm text-slate-300 hover:text-blue-400 transition cursor-pointer">联系客服</a>
                            </div>
                        </div>
                        <div>
                            <h4 className="text-sm text-slate-500 font-medium mb-4 uppercase tracking-wider">法律</h4>
                            <div className="space-y-3">
                                <a href="#" className="block text-sm text-slate-300 hover:text-blue-400 transition cursor-pointer">服务条款</a>
                                <a href="#" className="block text-sm text-slate-300 hover:text-blue-400 transition cursor-pointer">隐私政策</a>
                            </div>
                        </div>
                    </div>
                </div>

                <div className="pt-8 border-t border-white/10 text-center text-sm text-slate-500">
                    © 2026 TikTok Monitor. All rights reserved.
                </div>
            </div>
        </footer>
    );
}
