import React from "react";

// Feature icons as proper SVG components
const FeatureIcon = ({ type }: { type: string }) => {
    const iconMap: Record<string, React.ReactNode> = {
        monitor: (
            <svg className="w-10 h-10 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M9 3H4a1 1 0 00-1 1v16a1 1 0 001 1h16a1 1 0 001-1v-4" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="17" cy="7" r="4" />
                <path d="M21 11l-4-4" />
            </svg>
        ),
        analytics: (
            <svg className="w-10 h-10 text-cyan-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3v18h18" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M7 16l4-4 4 4 5-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        ),
        ai: (
            <svg className="w-10 h-10 text-orange-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32l1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
        ),
        export: (
            <svg className="w-10 h-10 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M7 10l5 5 5-5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        ),
        history: (
            <svg className="w-10 h-10 text-purple-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <circle cx="12" cy="12" r="10" />
                <path d="M12 6v6l4 2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        ),
        security: (
            <svg className="w-10 h-10 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
        ),
    };
    return iconMap[type] || iconMap.analytics;
};

const features = [
    {
        icon: "monitor",
        title: "实时多房间监控",
        description: "同时监控多个直播间，实时采集弹幕、礼物、点赞等数据，不遗漏任何互动"
    },
    {
        icon: "analytics",
        title: "智能数据分析",
        description: "自动生成送礼榜单、互动排行、时段分析，助您发现高价值用户"
    },
    {
        icon: "ai",
        title: "AI 用户画像",
        description: "AI 分析用户弹幕，自动识别语言偏好、兴趣话题，提供破冰建议"
    },
    {
        icon: "export",
        title: "数据导出",
        description: "一键导出用户数据到 Excel，方便进一步分析和运营跟进"
    },
    {
        icon: "history",
        title: "历史趋势",
        description: "保存完整直播历史，对比不同时段收益，优化直播策略"
    },
    {
        icon: "security",
        title: "安全可靠",
        description: "数据加密存储，独立账户隔离，保护您的商业数据安全"
    }
];

export function Features() {
    return (
        <section id="features" className="py-24 px-8 relative">
            {/* Decorative element */}
            <div className="orb orb-secondary w-[300px] h-[300px] -right-20 top-1/2 opacity-20"></div>

            <div className="max-w-7xl mx-auto relative z-10">
                <div className="text-center mb-16">
                    <span className="inline-block px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/30 text-sm text-blue-400 mb-4">
                        核心功能
                    </span>
                    <h2 className="text-4xl font-bold mb-4">为什么选择我们</h2>
                    <p className="text-slate-400 text-lg">专为直播运营打造的全方位数据分析工具</p>
                </div>

                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {features.map((feature, i) => (
                        <div key={i} className="card p-8 group">
                            <div className="mb-4 group-hover:scale-110 transition-transform duration-200">
                                <FeatureIcon type={feature.icon} />
                            </div>
                            <h3 className="text-xl font-semibold mb-3 text-white">{feature.title}</h3>
                            <p className="text-slate-400">{feature.description}</p>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
