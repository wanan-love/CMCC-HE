import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "sonner";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "河北移动资费观察 · 每日上下线时间轴",
  description:
    "中国移动河北资费公示每日对比：哪些资费上线了、哪些下线了、哪些内容变更了。时间轴形式展示每日资费动态，含下线预告与数据洞察。",
  keywords: ["中国移动", "资费公示", "河北移动", "套餐", "时间轴", "资费对比"],
  icons: {
    icon: "/logo.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="antialiased bg-background text-foreground min-h-screen">
        <Providers>{children}</Providers>
        <Toaster />
        {/* sonner 轻量 toast（详情/库/洞察/同步各组件使用），需挂载其自身 Toaster */}
        <SonnerToaster position="top-center" richColors closeButton toastOptions={{ style: { fontSize: 13 } }} />
      </body>
    </html>
  );
}
