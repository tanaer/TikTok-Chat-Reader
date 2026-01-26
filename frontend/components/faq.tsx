"use client";

import { useState } from "react";

const faqs = [
    {
        question: "如何开始使用？",
        answer: "注册账号后，在控制台添加要监控的TikTok直播间用户名即可开始采集数据。系统会自动检测开播状态并记录所有互动数据。"
    },
    {
        question: "支持哪些付款方式？",
        answer: "我们支持支付宝、微信支付、Stripe（信用卡/Visa/Mastercard）等主流支付方式。企业版客户还可以申请对公转账。"
    },
    {
        question: "AI分析额度是什么？",
        answer: "AI分析可以自动分析用户的弹幕内容，识别其语言偏好、兴趣话题，并提供破冰建议。每次分析消耗1个额度，套餐内含一定额度，用完可额外购买。"
    },
    {
        question: "数据安全如何保障？",
        answer: "所有数据采用加密传输和存储，每个用户的数据完全隔离。我们不会与任何第三方分享您的数据。"
    },
    {
        question: "可以随时取消订阅吗？",
        answer: "是的，您可以随时取消自动续费。取消后，当前订阅期内仍可正常使用所有功能。"
    },
    {
        question: "不同套餐的区别是什么？",
        answer: "套餐主要按可监控的房间数量区分。所有套餐功能完全开放，区别仅在于可监控房间数和每月AI分析额度。"
    }
];

// Chevron icon
const ChevronIcon = ({ isOpen }: { isOpen: boolean }) => (
    <svg
        className={`w-5 h-5 text-blue-400 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
    >
        <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

export function FAQ() {
    const [openIndex, setOpenIndex] = useState<number | null>(null);

    return (
        <section id="faq" className="py-24 px-8">
            <div className="max-w-3xl mx-auto">
                <div className="text-center mb-12">
                    <span className="inline-block px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/30 text-sm text-blue-400 mb-4">
                        常见问题
                    </span>
                    <h2 className="text-4xl font-bold">FAQ</h2>
                </div>

                <div className="space-y-4">
                    {faqs.map((faq, i) => (
                        <div key={i} className="card overflow-hidden">
                            <button
                                onClick={() => setOpenIndex(openIndex === i ? null : i)}
                                className="w-full flex items-center justify-between p-5 text-left font-medium hover:bg-white/5 transition-colors duration-200 cursor-pointer"
                            >
                                <span className="text-white">{faq.question}</span>
                                <ChevronIcon isOpen={openIndex === i} />
                            </button>
                            <div
                                className={`overflow-hidden transition-all duration-300 ${openIndex === i ? 'max-h-96' : 'max-h-0'
                                    }`}
                            >
                                <div className="px-5 pb-5 text-slate-400 leading-relaxed">
                                    {faq.answer}
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </section>
    );
}
