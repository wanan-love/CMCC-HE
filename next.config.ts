import type { NextConfig } from "next";

// NEXT_OUTPUT=export：静态导出模式（scripts/build-pages.sh 用于 Cloudflare Pages 部署）
// 默认 standalone：沙箱 dev server / 本地开发模式
const isExport = process.env.NEXT_OUTPUT === "export";

const nextConfig: NextConfig = {
  output: isExport ? "export" : "standalone",
  images: { unoptimized: true },
  /* config options here */
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
