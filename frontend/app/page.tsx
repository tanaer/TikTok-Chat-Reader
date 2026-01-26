import Link from "next/link";
import { Navbar } from "@/components/navbar";
import { Hero } from "@/components/hero";
import { Features } from "@/components/features";
import { Pricing } from "@/components/pricing";
import { FAQ } from "@/components/faq";
import { Footer } from "@/components/footer";

export default function Home() {
  return (
    <main className="min-h-screen">
      <Navbar />
      <Hero />
      <Features />
      <Pricing />
      <FAQ />

      {/* CTA Section */}
      <section className="py-24 px-8 text-center relative overflow-hidden">
        <div className="orb orb-primary w-[400px] h-[400px] -top-40 left-1/2 -translate-x-1/2"></div>
        <div className="max-w-2xl mx-auto relative z-10">
          <h2 className="text-4xl font-bold mb-4">准备好提升您的直播运营了吗？</h2>
          <p className="text-white/60 text-lg mb-8">
            立即注册，开始 7 天免费试用专业版功能
          </p>
          <Link
            href="/register"
            className="btn-gradient inline-flex items-center gap-2 px-8 py-4 rounded-lg text-lg"
          >
            免费开始
          </Link>
        </div>
      </section>

      <Footer />
    </main>
  );
}
