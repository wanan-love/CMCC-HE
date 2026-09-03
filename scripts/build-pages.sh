#!/usr/bin/env bash
# 静态导出构建 → pages-out/（供 wrangler pages deploy 使用）
#
# 关键设计：在隔离副本中构建，绝不触碰运行中 dev server 的 .next 目录
#   1. 复制项目（排除 node_modules/.next/.git/seed/db 等）到 /tmp 临时目录
#   2. 副本中删除 src/app/api（本地开发用的 Prisma 路由；生产 API 由 functions/ 提供）
#   3. 软链 node_modules → 共享依赖（含已生成的 prisma client）
#   4. NEXT_OUTPUT=export 触发 next.config.ts 的 output:'export' 分支
#   5. out/ 拷回 pages-out/
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/pages-out"
BUILD_DIR=$(mktemp -d /tmp/cmcc-pages-build.XXXXXX)
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "==> 复制项目到隔离构建目录 $BUILD_DIR"
cd "$ROOT"
tar -cf - \
  --exclude=node_modules --exclude=.next --exclude=.git \
  --exclude=seed --exclude=db --exclude=pages-out \
  --exclude=dev.log --exclude=tool-results --exclude='qa-*.png' \
  --exclude=.env --exclude=.wrangler \
  --exclude=examples --exclude=mini-services --exclude=.zscripts \
  --exclude=docs --exclude=.github --exclude=download \
  . | (cd "$BUILD_DIR" && tar -xf -)

echo "==> 移除本地开发 API 路由（生产由 functions/ 提供）"
rm -rf "$BUILD_DIR/src/app/api"

echo "==> 硬链接复制 node_modules（Turbopack 拒绝跨根软链；硬链接秒级且零额外磁盘占用）"
cp -al "$ROOT/node_modules" "$BUILD_DIR/node_modules"

echo "==> next build（output:export）"
cd "$BUILD_DIR"
NEXT_OUTPUT=export ./node_modules/.bin/next build

echo "==> 输出到 $OUT_DIR"
rm -rf "$OUT_DIR"
cp -r "$BUILD_DIR/out" "$OUT_DIR"
echo "✅ 静态导出完成: $OUT_DIR（$(find "$OUT_DIR" -type f | wc -l) 个文件）"
