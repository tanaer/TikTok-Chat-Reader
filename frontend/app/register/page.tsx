"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, Suspense } from "react";
import { authApi } from "@/lib/api";

function RegisterForm() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const plan = searchParams.get("plan");
    const billing = searchParams.get("billing");

    const [email, setEmail] = useState("");
    const [nickname, setNickname] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [agree, setAgree] = useState(false);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");

        if (password !== confirmPassword) {
            setError("两次输入的密码不一致");
            return;
        }

        if (!agree) {
            setError("请同意服务条款和隐私政策");
            return;
        }

        setLoading(true);

        try {
            await authApi.register(email, password, nickname || undefined);

            // If plan was specified, redirect to checkout
            if (plan && plan !== "免费版") {
                router.push(`/dashboard?checkout=${plan}&billing=${billing || "monthly"}`);
            } else {
                router.push("/dashboard");
            }
        } catch (err: any) {
            setError(err.message || "注册失败");
        } finally {
            setLoading(false);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="space-y-5">
            <div>
                <label className="block text-sm font-medium mb-2">邮箱</label>
                <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your@email.com"
                    required
                />
            </div>

            <div>
                <label className="block text-sm font-medium mb-2">
                    昵称 <span className="text-white/40">(选填)</span>
                </label>
                <input
                    type="text"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder="您的昵称"
                />
            </div>

            <div>
                <label className="block text-sm font-medium mb-2">密码</label>
                <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="至少6个字符"
                    minLength={6}
                    required
                />
            </div>

            <div>
                <label className="block text-sm font-medium mb-2">确认密码</label>
                <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="再次输入密码"
                    required
                />
            </div>

            <label className="flex items-start gap-2 cursor-pointer text-sm text-white/60">
                <input
                    type="checkbox"
                    checked={agree}
                    onChange={(e) => setAgree(e.target.checked)}
                    className="w-4 h-4 mt-0.5 accent-[#00f5d4]"
                />
                <span>
                    我同意 <a href="#" className="text-[#00f5d4]">服务条款</a> 和{" "}
                    <a href="#" className="text-[#00f5d4]">隐私政策</a>
                </span>
            </label>

            <button
                type="submit"
                disabled={loading}
                className="btn-gradient w-full py-4 rounded-lg text-lg font-semibold disabled:opacity-50"
            >
                {loading ? "注册中..." : "免费注册"}
            </button>

            {error && (
                <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm text-center">
                    {error}
                </div>
            )}
        </form>
    );
}

export default function RegisterPage() {
    return (
        <div className="min-h-screen flex items-center justify-center p-8 relative">
            {/* Background orbs */}
            <div className="orb orb-primary w-[600px] h-[600px] -top-48 -right-48"></div>
            <div className="orb orb-secondary w-[400px] h-[400px] bottom-0 -left-20"></div>

            <div className="glass rounded-2xl p-12 w-full max-w-md relative z-10">
                <Link href="/" className="flex items-center justify-center gap-2 text-xl font-bold mb-8">
                    <span className="text-2xl">📊</span>
                    <span>TikTok Monitor</span>
                </Link>

                <h1 className="text-2xl font-bold text-center mb-2">创建账户</h1>
                <p className="text-white/60 text-center mb-8">开始您的免费试用</p>

                <Suspense fallback={<div>Loading...</div>}>
                    <RegisterForm />
                </Suspense>

                <p className="text-center text-white/60 mt-8">
                    已有账户？
                    <Link href="/login" className="text-[#00f5d4] font-medium ml-1 hover:underline">
                        立即登录
                    </Link>
                </p>
            </div>
        </div>
    );
}
