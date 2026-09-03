# CMCC-HE · 河北移动资费观察

中国移动河北资费公示页每日快照对比 —— 哪些资费上线了、哪些下线了、哪些内容变了。以时间轴形式呈现每日资费动态，含下线预告与数据洞察。

**线上站点**：[hhttps://cmcc-he.pages.dev

## 架构

```
┌─────────────────┐   每日 04:00（北京）      ┌─────────────────────────────┐
│  GitHub Actions │  POST /api/sync          │  Cloudflare Pages           │
│  Playwright     │  ──────────────────────► │  ├─ 前端 静态导出（CDN）     │
│  ├─ WARP 出口    │  Bearer <SYNC_TOKEN>     │  ├─ API Pages Functions     │
│  ├─ 真人节奏抓取 │                          │  │   └─ 差异对比引擎        │
│  └─ 归一化      │                          │  └─ D1（SQLite）            │
└─────────────────┘                          └─────────────────────────────┘
```

三层完全分离：

| 层 | 技术 | 说明 |
|---|---|---|
| 采集 | GitHub Actions + Playwright Chromium | 公示页是 Vue SPA 且请求体加密，必须跑真实浏览器；出口走 Cloudflare WARP，节奏全程随机化模仿真人 |
| 存储 | Cloudflare D1 | 少行大 JSON 设计：无变化不写、批量事务提交，每日真实写入仅变更行（0~50 行） |
| 展示 | Cloudflare Pages | 前端纯静态（客户端渲染），API 为 Pages Functions + D1 binding |

## 功能

- **时间轴**：按日分组的上线/下线/变更事件流，热力图、月份/年份/日期下钻、关键词与高级筛选（类型多选包含/排除、内容关键词、价格区间）
- **资费库**：全量在售/已下线资费，价格带/分类/关键词筛选，详情页含变更历史与相似资费推荐
- **下线预告**：按 offlineDate 倒计时的即将下线列表
- **数据洞察**：分类构成、24 个月月度三序列、价格分布、年度分布、中位价统计
- **导出与订阅**：CSV 导出（资费库/事件）、RSS / JSON 订阅源
- **更新动态**：页头 Popover 展示每日抓取运行记录（新增/下线/变更计数），可下钻当日时间轴
- **深链接**：8 个 URL 参数（tab/tariff/q/month/year/date/band/category）全部可分享、可后退

## 数据口径

- 数据来源：[中国移动资费公示页（河北）](https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html?pageId=834148205904408576&prov=531)（个人/政企 × 全网/河北 × 套餐/加装包/营销活动/港澳台国际）
- 每日 04:00 抓取一次（GitHub Actions cron，UTC 20:00）；首灌按「上线日期」重构历史事件
- `lastSeenAt` 语义为「内容最后一次确认」——无变化的资费不产生任何写入

## 本地开发

```bash
bun install
cp .env.example .env          # DATABASE_URL=file:./db/custom.db
bun run db:generate && bun run db:push
bun run dev                   # http://localhost:3000（Next dev + Prisma/SQLite）

# 本地灌一份数据（可选）：
bun run scrape                # Playwright 抓取公示页 → seed/*.json
bun run normalize && bun run seed

# 手动推送数据到线上（需令牌）：
SYNC_API_URL=https://cmcc-he.pages.dev/api/sync SYNC_TOKEN=xxx bun run push-sync
```

> 本地开发用 Prisma + SQLite（`src/app/api/*`）；生产走 `functions/api/[[path]].ts` + D1，二者接口完全一致。

## 部署（Cloudflare Pages + D1）

```bash
# 首次：创建 D1 + Pages 项目 + Secret + 建表
wrangler d1 create cmcc-he-db                    # 把 database_id 填进 wrangler.toml
wrangler pages project create cmcc-he --production-branch main
echo "<token>" | wrangler pages secret put SYNC_TOKEN --project-name cmcc-he
wrangler d1 execute cmcc-he-db --remote --file migrations/0001_init.sql

# 日常发布：静态导出（隔离构建，不影响 dev server）+ Functions 一并部署
bun run deploy
```

详细设计（容量估算、读写费用优化、防风控）见 [docs/DEPLOY-CLOUDFLARE.md](docs/DEPLOY-CLOUDFLARE.md)。

## GitHub Actions

仓库 Secrets：

| Secret | 值 |
|---|---|
| `SYNC_API_URL` | `https://cmcc-he.pages.dev/api/sync` |
| `SYNC_TOKEN` | 与 Pages Secret 一致的密钥 |

每日 UTC 20:00 自动运行：WARP 连接 → 真人节奏抓取 → 归一化 → sanity check → Bearer 推送 → 快照归档 artifact（90 天）。也可在 Actions 页面手动 `Run workflow`。

## 目录结构

```
functions/api/[[path]].ts   生产 API（Pages Functions + D1，含差异同步引擎）
src/                        前端（Next.js App Router，全客户端渲染）
src/app/api/                本地开发 API（Prisma + SQLite，与生产同构）
scripts/                    抓取/归一化/推送/建库/构建脚本
migrations/                 D1 建表 SQL
prisma/                     本地 SQLite schema
.github/workflows/          每日采集 workflow
```

## 免责声明

本项目仅对公开的资费公示页做归档与对比分析，供个人学习研究。资费信息以中国移动官方渠道为准。
