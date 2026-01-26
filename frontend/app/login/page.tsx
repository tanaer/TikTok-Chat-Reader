"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { authApi } from "@/lib/api";

export default function LoginPage() {
    const router = useRouter();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setError("");
        setLoading(true);

        try {
            await authApi.login(email, password);
            router.push("/dashboard");
        } catch (err: any) {
            setError(err.message || "登录失败");
        } finally {
            setLoading(false);
        }
    };

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

                <h1 className="text-2xl font-bold text-center mb-2">欢迎回来</h1>
                <p className="text-white/60 text-center mb-8">登录您的账户</p>

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
                        <label className="block text-sm font-medium mb-2">密码</label>
                        <input
                            type="password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            placeholder="••••••••"
                            required
                        />
                    </div>

                    <div className="flex items-center justify-between text-sm">
                        <label className="flex items-center gap-2 cursor-pointer text-white/60">
                            <input type="checkbox" className="w-4 h-4 accent-[#00f5d4]" />
                            记住我
                        </label>
                        <a href="#" className="text-white/60 hover:text-white transition">
                            忘记密码？
                        </a>
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="btn-gradient w-full py-4 rounded-lg text-lg font-semibold disabled:opacity-50"
                    >
                        {loading ? "登录中..." : "登录"}
                    </button>

                    {error && (
                        <div className="p-4 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm text-center">
                            {error}
                        </div>
                    )}
                </form>

                <p className="text-center text-white/60 mt-8">
                    还没有账户？
                    <Link href="/register" className="text-[#00f5d4] font-medium ml-1 hover:underline">
                        免费注册
                    </Link>
                </p>
            </div>
        </div>
    );
}
