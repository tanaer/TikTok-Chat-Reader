import Link from "next/link";

export function Hero() {
    return (
        <section className="min-h-screen pt-32 pb-20 px-8 relative overflow-hidden">
            {/* Background orbs - Blue/Cyan theme */}
            <div className="orb orb-primary w-[600px] h-[600px] -top-48 -right-48 animate-pulse-slow"></div>
            <div className="orb orb-secondary w-[400px] h-[400px] bottom-20 -left-20"></div>
            <div className="orb orb-accent w-[200px] h-[200px] bottom-40 right-1/4 opacity-30"></div>

            <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
                {/* Left content */}
                <div className="relative z-10">
                    {/* Promo badge with blue/orange theme */}
                    <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-blue-500/20 border border-blue-500/40 text-sm mb-6">
                        <svg className="w-4 h-4 text-orange-400" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
                        </svg>
                        <span className="text-blue-200">专业版限时 7 折优惠</span>
                    </div>

                    <h1 className="text-5xl lg:text-6xl font-extrabold leading-tight mb-6">
                        <span className="gradient-text">TikTok 直播</span>
                        <br />
                        <span className="text-white">数据分析平台</span>
                    </h1>

                    <p className="text-xl text-slate-400 leading-relaxed mb-8 max-w-lg">
                        实时监控多个直播间，智能分析送礼用户行为，帮助主播和MCN提升运营效率和收益
                    </p>

                    <div className="flex flex-wrap gap-4 mb-12">
                        <Link
                            href="/register"
                            className="btn-cta flex items-center gap-2 px-8 py-4 rounded-lg text-lg font-semibold"
                        >
                            开始免费试用
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M5 12h14"></path>
                                <path d="m12 5 7 7-7 7"></path>
                            </svg>
                        </Link>
                        <a
                            href="#pricing"
                            className="btn-outline flex items-center px-8 py-4 rounded-lg cursor-pointer"
                        >
                            查看定价
                        </a>
                    </div>

                    {/* Stats with Fira Code font */}
                    <div className="flex gap-12">
                        <div className="text-center">
                            <div className="text-3xl font-bold font-mono text-blue-400">10K+</div>
                            <div className="text-sm text-slate-500">监控房间</div>
                        </div>
                        <div className="text-center">
                            <div className="text-3xl font-bold font-mono text-cyan-400">500M+</div>
                            <div className="text-sm text-slate-500">处理事件</div>
                        </div>
                        <div className="text-center">
                            <div className="text-3xl font-bold font-mono text-green-400">99.9%</div>
                            <div className="text-sm text-slate-500">在线率</div>
                        </div>
                    </div>
                </div>

                {/* Right - Dashboard preview */}
                <div className="relative z-10 hidden lg:block">
                    <div className="glass rounded-2xl overflow-hidden shadow-2xl border border-blue-500/20">
                        <div className="flex items-center gap-3 px-4 py-3 bg-slate-800/50 border-b border-white/10">
                            <div className="flex gap-2">
                                <span className="w-3 h-3 rounded-full bg-red-500"></span>
                                <span className="w-3 h-3 rounded-full bg-yellow-500"></span>
                                <span className="w-3 h-3 rounded-full bg-green-500"></span>
                            </div>
                            <span className="text-sm text-slate-400 font-mono">Live Dashboard</span>
                        </div>
                        <div className="grid grid-cols-[180px_1fr] min-h-[300px]">
                            {/* Sidebar */}
                            <div className="p-4 border-r border-white/10 space-y-2">
                                <div className="flex items-center gap-2 p-3 rounded-lg bg-blue-500/10 border border-blue-500/30 cursor-pointer">
                                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                                    <span className="text-sm">主播A</span>
                                    <span className="ml-auto text-xs text-orange-400 font-mono">12.5K</span>
                                </div>
                                <div className="flex items-center gap-2 p-3 rounded-lg hover:bg-white/5 cursor-pointer transition-colors">
                                    <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse"></span>
                                    <span className="text-sm">主播B</span>
                                    <span className="ml-auto text-xs text-orange-400 font-mono">8.2K</span>
                                </div>
                                <div className="flex items-center gap-2 p-3 rounded-lg hover:bg-white/5 cursor-pointer transition-colors">
                                    <span className="w-2 h-2 rounded-full bg-gray-500"></span>
                                    <span className="text-sm text-slate-400">主播C</span>
                                    <span className="ml-auto text-xs text-slate-500 font-mono">5.1K</span>
                                </div>
                            </div>

                            {/* Main */}
                            <div className="p-4">
                                {/* Chart placeholder - blue gradient */}
                                <div className="h-24 mb-4 rounded-lg bg-gradient-to-b from-blue-500/10 to-transparent border-b-2 border-blue-500 relative overflow-hidden">
                                    <div className="absolute bottom-0 left-0 right-0 h-3/4 bg-gradient-to-r from-transparent via-blue-500/30 to-cyan-500/50"
                                        style={{ clipPath: "polygon(0 100%, 10% 60%, 25% 80%, 40% 40%, 55% 60%, 70% 30%, 85% 50%, 100% 20%, 100% 100%)" }}></div>
                                </div>

                                {/* Messages */}
                                <div className="space-y-2 text-sm">
                                    <div className="p-2 rounded-lg bg-white/5">
                                        <span className="text-blue-400 font-medium">User123</span>: 送出玫瑰×10
                                    </div>
                                    <div className="p-2 rounded-lg bg-white/5">
                                        <span className="text-cyan-400 font-medium">BigFan</span>: 太棒了！
                                    </div>
                                    <div className="p-2 rounded-lg bg-orange-500/10 border-l-2 border-orange-500">
                                        <span className="text-orange-400 font-medium">VIP用户</span>: 送出TikTok×5
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    );
}
