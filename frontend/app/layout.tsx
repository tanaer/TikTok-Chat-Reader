import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TikTok Monitor - 专业直播数据分析平台",
  description: "实时监控TikTok直播间数据，智能分析用户行为，提升直播收益。专业MCN机构首选工具。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" className="dark">
      <body className={`${inter.variable} font-sans antialiased bg-[#0a0a0f] text-white`}>
        {children}
      </body>
    </html>
  );
}
