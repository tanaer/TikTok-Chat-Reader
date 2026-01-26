"use client";

import Link from "next/link";
import { useState } from "react";

type BillingCycle = "monthly" | "quarterly" | "annual";

const plans = [
    {
        name: "免费版",
        price: { monthly: 0, quarterly: 0, annual: 0 },
        rooms: 1,
        aiCredits: 10,
        features: ["基础数据统计", "7天历史数据", "所有功能开放"],
        cta: "免费注册",
        popular: false
    },
    {
        name: "基础版",
        price: { monthly: 29, quarterly: 79, annual: 269 },
        rooms: 5,
        aiCredits: 50,
        features: ["完整数据统计", "30天历史数据", "数据导出Excel", "所有功能开放"],
        cta: "立即订阅",
        popular: true
    },
    {
        name: "专业版",
        price: { monthly: 99, quarterly: 269, annual: 899 },
        rooms: 20,
        aiCredits: 200,
        features: ["完整数据统计", "无限历史数据", "数据导出Excel", "所有功能开放"],
        cta: "立即订阅",
        popular: false
    },
    {
        name: "企业版",
        price: { monthly: 299, quarterly: 799, annual: 2699 },
        rooms: -1, // unlimited
        aiCredits: 1000,
        features: ["API接口访问", "白标定制", "专属客服支持", "无限历史数据"],
        cta: "联系我们",
        popular: false
    }
];

const billingLabels: Record<BillingCycle, string> = {
    monthly: "月付",
    quarterly: "季付",
    annual: "年付"
};

const discounts: Record<BillingCycle, string | null> = {
    monthly: null,
    quarterly: "省10%",
    annual: "省25%"
};

// Checkmark icon
const CheckIcon = () => (
    <svg className="w-5 h-5 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

export function Pricing() {
    const [billing, setBilling] = useState<BillingCycle>("monthly");

    return (
        <section id="pricing" className="py-24 px-8 relative">
            {/* Background decoration */}
            <div className="orb orb-primary w-[400px] h-[400px] -left-40 top-1/3 opacity-20"></div>

            <div className="max-w-7xl mx-auto relative z-10">
                <div className="text-center mb-12">
                    <span className="inline-block px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/30 text-sm text-blue-400 mb-4">
                        定价方案
                    </span>
                    <h2 className="text-4xl font-bold mb-4">选择适合您的方案</h2>
                    <p className="text-slate-400 text-lg">灵活的订阅计划，以房间数区分，所有功能全开放</p>
                </div>

                {/* Billing toggle */}
                <div className="flex justify-center gap-2 mb-12">
                    {(Object.keys(billingLabels) as BillingCycle[]).map((cycle) => (
                        <button
                            key={cycle}
                            onClick={() => setBilling(cycle)}
                            className={`px-6 py-3 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer ${billing === cycle
                                ? "btn-primary"
                                : "bg-white/5 border border-white/10 text-slate-400 hover:text-white hover:border-blue-500/50"
                                }`}
                        >
                            {billingLabels[cycle]}
                            {discounts[cycle] && (
                                <span className="ml-2 px-2 py-0.5 rounded bg-green-500/20 text-green-400 text-xs">
                                    {discounts[cycle]}
                                </span>
                            )}
                        </button>
                    ))}
                </div>

                {/* Plans grid */}
                <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
                    {plans.map((plan, i) => (
                        <div
                            key={i}
                            className={`card p-6 relative ${plan.popular ? "border-orange-500/50 bg-gradient-to-b from-orange-500/10 to-transparent" : ""
                                }`}
                        >
                            {plan.popular && (
                                <div className="absolute -top-3 left-1/2 -translate-x-1/2 px-4 py-1 rounded-full btn-cta text-xs font-semibold">
                                    最受欢迎
                                </div>
                            )}

                            <div className="text-center pb-6 border-b border-white/10 mb-6">
                                <h3 className="text-xl font-semibold mb-4">{plan.name}</h3>
                                <div className="flex items-baseline justify-center gap-1">
                                    <span className="text-4xl font-bold font-mono">¥{plan.price[billing]}</span>
                                    <span className="text-slate-500">/{billing === "monthly" ? "月" : billing === "quarterly" ? "季" : "年"}</span>
                                </div>
                            </div>

                            <ul className="space-y-3 mb-6">
                                <li className="flex items-center gap-3">
                                    <CheckIcon />
                                    <span>{plan.rooms === -1 ? "不限" : plan.rooms} 个监控房间</span>
                                </li>
                                <li className="flex items-center gap-3">
                                    <CheckIcon />
                                    <span>{plan.aiCredits} 次/月 AI分析</span>
                                </li>
                                {plan.features.map((feature, j) => (
                                    <li key={j} className="flex items-center gap-3">
                                        <CheckIcon />
                                        <span>{feature}</span>
                                    </li>
                                ))}
                            </ul>

                            <Link
                                href={`/register?plan=${plan.name}&billing=${billing}`}
                                className={`block w-full py-3 rounded-lg text-center font-medium transition-all duration-200 cursor-pointer ${plan.popular
                                    ? "btn-cta"
                                    : "border border-white/10 hover:bg-white/5 hover:border-blue-500/50"
                                    }`}
                            >
                                {plan.cta}
                            </Link>
                        </div>
                    ))}
                </div>

                {/* AI credits note */}
                <p className="text-center text-slate-500 text-sm mt-8">
                    AI分析额度用完后可额外购买：¥10 / 100次
                </p>
            </div>
        </section>
    );
}
