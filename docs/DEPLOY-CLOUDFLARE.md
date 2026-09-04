# 部署方案：Cloudflare Pages + D1 + GitHub Actions 每日抓取

> 本文档回答三个核心问题：**为什么抓取放 GitHub Actions、同步接口如何加密、D1 容量与读写费用是否可控**，并给出完整落地步骤。

## 〇、公示页接口逆向与齐全性校验（2026-09-04）

采集范围 = 个人 × 河北分省 × **全部资费类型**（套餐 / 加装包 / 营销活动 / 港澳台(国际)资费 /
**标准资费** / 国际及港澳台标准资费 / 其他——下拉选项运行时动态枚举，页面增删类型自动覆盖）。

**页面结构（Vue + webpack 动态 chunk，静态资源域 `res.app.coc.10086.cn` 可直抓分析）：**

| chunk | 职责 |
|---|---|
| `tariffZonePers.js` | 入口 + Vuex store + API 模块 |
| `templateCollection.js` | CMS 模板集（zf06Container 资费容器） |
| `js/155.js` NavBarNew | 导航条：页签（全网/分省）、类型/系列/价格下拉、列表分页 + 懒加载 |
| `js/837.js` tariffSerial | 资费卡片（`.tariff-item-container` 系选择器） |
| `js/929/715/88/814.js` | 标准资费表格视图（StandarTariff → FreeContent → FreeDetail → vxe-table） |

**关键接口（业务域 `h.app.coc.10086.cn`，均 POST JSON）：**

| 接口 | 请求 | 响应要点 |
|---|---|---|
| `/website/nrapigate/nrtariff/new/Tariff/getTariffListInfo` | `{cellNum:'99999999999', province:'311', isPublic:'1', linkScn:'1', tariffAttr:'1'全网/'2'分省, type1:'1'个人/'2'政企, type2:'1'~'7', page, limit:5}` | `rspBody.(data?).{page:{total}, beans:[卡片数据]}` |
| `/website/nrapigate/nrtariff/new/Tariff/getStandardlist` | `{province:'311', isPublic:'1'}` | `rspBody[0].tariffTable` 或 `rspBody.tariffList[0].tariffTable` = `{tHead, tBody}`（**官方页面只用第一组表格；采集端全量提取所有组**） |
| `/website/nrapigate/nrtariff/new/Tariff/getType2List` | 同上省参数 | 当前（type1×tariffAttr）可用的类型清单 |

**★ isWX 加密通道（2026-09-04 二次逆向，v4 关键发现）：** 上述接口全部走加密通道——
请求体经 `ff()` 加密后发出，网络层响应是 `{body:'<密文>'}` 信封，在 axios 响应拦截器内
经 `F6()` 解密后 `JSON.parse` 才得到业务明文（chunk-common.js 响应拦截器实证）。因此：
- **网络层拦截（page.on('response')）永远拿不到 page.total/beans/表格**——v3 的
  「接口 total=未知 ⚠ 未核对」齐全性闸门因此形同虚设（事故根因之一）；
- v4 改用 **应用层捕获**：addInitScript 在页面 JS 之前 hook 全局 `JSON.parse`（解密
  明文必经之路）+ 包装 XHR `onreadystatechange`（axios 绑定方式）关联请求 URL，
  实现端点级明文捕获；数据本身仍以 DOM 卡片为主源（捕获的 beans 归档备未来直连）。

**类型值映射（chunk-155 内硬编码）：** 1 套餐 / 2 加装包 / 3 营销活动 / 4 港澳台/国际资费 /
5 标准资费（下拉里是特殊值 `标准资费VALUE`，仅分省页签且标准数据存在时出现，**不走列表 API**，
数据在选省时由 getStandardlist 拉取）/ 6 国际及港澳台标准资费 / 7 其他。
河北省份编码 `311`（URL 里的 `prov=531` 是山东，页面加载后需手动切省）。

**齐全性校验（scrape.mjs v4 内置，严格门禁）：** 应用层捕获的明文 `page.total` 逐一核对
每类型实际抓到的 DOM 卡片数（DOM 即 beans 渲染结果）；标准资费直接消费 getStandardlist
解密明文的【全部表格组】（tHead/tBody → 卡片字段，无方案编号的行合成 `STD-<md5(名称)>`
稳定编号，内容变化=同编号 contentHash 变化=UPDATED 事件）。门禁规则（宁缺毋滥）：
- 类型选项在下拉中存在 ⇒ 必须有数据：count==0 且 apiTotal≠0（含未知）即 FAILED——
  2026-09-04 事故（套餐被下拉切换 bug 跳过 → 0 条照常推送 → 502 条全部误判下线）根因修复；
- count>0 且 apiTotal 已知 ⇒ 必须 count ≥ apiTotal（自愈重滚后仍不足即 FAILED）；
- 任一 FAILED → 脚本非零退出 → workflow 中止（不推送）。
报告与 beans/标准资费明文落盘 `seed/api/` 随 artifact 归档。

**推送侧双闸门（push-sync.mjs + 同步 API）：**
- 数量闸门：本次抓取数 < 线上在售 × 0.8 时中止（防懒加载截断型漏抓）；
- 分类归零闸门（同步 API 服务端）：线上某分类在线 ≥ 20 条而本次抓取该分类为 0 → 拒绝同步；
- REMOVED 二次确认（同步引擎）：在线但本次未抓到 → missCount+1，连续 2 个快照日未见才
  判下线 + REMOVED 事件；单次缺失保持 ONLINE 不产生事件（杜绝假下线污染时间轴）。

## 一、架构总览

```
┌─────────────────┐   每日 04:00（北京）    ┌──────────────────────────┐
│  GitHub Actions │ ──────────────────────► │  Cloudflare Pages 站点    │
│  Playwright     │   POST /api/sync        │  ├─ 前端（Next.js SSR）   │
│  抓取公示页      │   Authorization:        │  ├─ API Functions        │
│  → 归一化        │   Bearer <SYNC_TOKEN>   │  │   └─ 差异对比引擎      │
└─────────────────┘                          │  └─ D1（SQLite 数据库）  │
                                             └──────────────────────────┘
```

**为什么抓取用 GitHub Actions 而不是 Workers Cron：**
- 移动公示页是 Vue SPA，资费列表靠 JS 动态渲染，且请求体加密（API 直连不可行）——必须跑真实浏览器（Playwright Chromium）；
- Cloudflare Workers 无法运行无头浏览器（浏览器渲染协议在 Workers 中不可用），且 CPU 时间限额（免费 10ms / 付费 5min）远不够渲染 3000+ 卡片；
- GitHub Actions 的 ubuntu-latest runner 免费提供 Chromium 环境，`cron` 定时 + artifact 备份 + 失败重试，全部免费。
- 每日快照归档为 Actions artifact（保留 90 天），同时是数据备份与审计线索。

## 二、后端存储：现在是什么？D1 够不够？

**现状（沙箱）**：SQLite 单文件（Prisma ORM），`db/custom.db`。
（2026-09 起采集范围收敛为仅「个人×河北」，下表为原 4 阶段全量时代的实测基准，
收敛后行数仅为其中「个人×河北」部分，容量结论只会更宽裕。）

**生产方案**：Cloudflare **D1**（就是托管版 SQLite），三张表结构不变：

| 表 | 原全量基准行数 | 平均行大小 |
|---|---|---|
| Tariff（资费当前态） | 3,109（4 阶段全量） | ~775 B |
| ChangeEvent（变更事件） | 3,109 | ~292 B |
| SyncRun（同步记录） | 17 | ~200 B |

**容量估算（0.5 GB 上限内吗？——完全够）：**

| 增长项 | 速率 | 5 年后 |
|---|---|---|
| Tariff（新资费累积，下线行保留） | ~5-10 行/天 × 775B | ≈ +10-14 MB |
| ChangeEvent（真实变更，公示页日变更通常 0~50 条，按 20 条/天均值） | 7,300 行/年 × 292B | ≈ +10.7 MB |
| SyncRun（每日 1 行） | 365 行/年 | ≈ +0.4 MB |
| **合计** | | **≈ 30-35 MB ＜ 0.5 GB（1/15）** |

即使公示页改版导致一次性大重构（如全量 3,109 条事件重灌一次），也只 +0.9 MB。**结论：D1 免费层 5 GB 总量 / 0.5 GB 单库上限完全够用，可用十年以上。**

## 三、D1 读写费用优化（计费 = 按行数，行内容大小不计费）

D1 免费层：**每天 500 万行读 / 10 万行写**。本项目设计天然契合"行少内容多"：

1. **「无变化不写」**（已实现于 `/api/sync` 差异引擎）：
   抓取 3,109 条中未变化的资费**不再逐行刷新 `lastSeenAt`**（旧行为每天白写 3,100+ 行）；
   `lastSeenAt` 语义收敛为「内容最后一次确认」。每日真实写入 = 变更行（0~50）+ 1 行 SyncRun。
   → **每天写入 ≈ 50 行，占用免费额度 0.05%**。

2. **批量提交**（已实现）：新增资费 / 事件 `createMany` 按 500 条/事务攒批，下线检测用 `updateMany`，单次网络往返。

3. **行内容可以多**（schema 天然如此）：套餐内容（`usageJson`）、其他说明（`extraJson`）整段 JSON 存单行单列——D1 按行计费、不按字节计费，**这正是"每行内容多、行数少"的最优形态**。

4. **读路径全部走索引 + 分页**：
   - 每日 diff 全表读一次 ≈ 3,109 行（免费额度 0.06%/天）；
   - 页面查询：timeline `groupBy(date,type)` + 每页 12 天 × 60 条明细、资费库 12 条/页 + count、upcoming 最多 1,000 行——单次页面加载 ≈ 200-500 行读；
   - 建议：为 `/api/stats`、`/api/insights` 等聚合接口加 `Cache-Control`（或 CDN 缓存 60s，前端 React Query 已有 60s staleTime），1,000 PV/天也在 50 万行读以内。

5. **防误写（双闸门，2026-09-04 首跑实测后加固）**：
   - `push-sync.mjs` 推送前拉取线上在售数（`GET /api/stats`）作基线，本次抓取数 < 线上在售 × 0.8
     （`MIN_SYNC_RATIO` 可调）时**中止推送**——防止漏抓批次（懒加载截断 / WARP 慢出口批次延迟 /
     出口限流）把大量在线资费误判下线污染时间轴。**宁缺毋滥**：当天数据缺失可接受，假下线事件不可接受；
   - 抓取端 `scrollAll` 到底后最多 3 轮长停顿复查（8~15s/轮），任一轮有新增即继续滚动——
     覆盖慢出口在途批次（首跑实测 WARP TUN 出口批次延迟 >60s 导致 150/502 漏抓，已修复）；
   - workflow sanity check 阈值 100 条（防公示页改版/选择器失效）。

## 四、同步接口加密（已实现）

`POST /api/sync` 鉴权逻辑（见 `src/app/api/sync/route.ts`）：

- 线上设置环境变量 `SYNC_TOKEN`（生成：`openssl rand -hex 32`）；
- 请求需带 `Authorization: Bearer <token>`（也支持 `x-sync-token` 头或 `?token=`）；
- `timingSafeEqual` 防时序攻击；错误一律 401；
- **未配置 `SYNC_TOKEN` 时放行**（本地/沙箱开发模式），生产务必配置；
- `GET /api/sync`（只读运行记录）保持公开，无敏感数据。

## 五、部署步骤（Cloudflare Pages）

### 5.1 准备 D1

```bash
# 安装 wrangler 并登录
npm i -g wrangler && wrangler login

# 创建数据库（一个就够，Free 计划 10 个）
wrangler d1 create hebei-tariff
# 记下输出的 database_id

# 用 Prisma 生成建表 SQL（schema 不变，sqlite 方言直接兼容 D1）
npx prisma migrate diff \
  --from-empty --to-schema-datamodel prisma/schema.prisma --script > migrations/0001_init.sql

# 在 D1 中执行（--remote 生产库；--local 本地预览）
wrangler d1 execute hebei-tariff --remote --file migrations/0001_init.sql
```

### 5.2 项目改造（Prisma → D1 driver adapter）

```bash
bun add @prisma/adapter-d1
```

`prisma/schema.prisma` generator 开启 driverAdapters（其余不变）：

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["driverAdapters"]
}
```

`src/lib/db.ts`（沙箱仍是 SQLite 文件；生产构建走 D1 分支）：

```ts
import { PrismaClient } from '@prisma/client'
import { PrismaD1 } from '@prisma/adapter-d1'

function createClient() {
  // Cloudflare Pages 环境（有 D1 binding）
  if (process.env.DB instanceof Object) {
    return new PrismaClient({ adapter: new PrismaD1(process.env.DB as any) })
  }
  // 本地开发：SQLite 文件
  const { PrismaClient: P } = require('@prisma/client')
  return new P({ datasources: { db: { url: process.env.DATABASE_URL } } })
}
export const db = createClient()
```

### 5.3 Pages 项目

```bash
# Next.js 全栈上 Pages（App Router + API Routes 均支持，Edge runtime）
npx @cloudflare/next-on-pages
npx wrangler pages deploy .vercel/output/static --project-name hebei-tariff-watch
```

`wrangler.toml`（或 Pages 控制台绑定）：

```toml
name = "hebei-tariff-watch"
compatibility_date = "2024-09-01"
compatibility_flags = ["nodejs_compat"]

[[d1_databases]]
binding       = "DB"
database_name = "hebei-tariff"
database_id   = "<上一步记下的 id>"
```

> 注意：`/api/sync` 使用 `fs.readFileSync` 读种子文件——**生产走 `mode:'items'`（远端直传）分支，不触磁盘**；seed 分支仅本地使用。所有 API route 已带 `export const dynamic = 'force-dynamic'`，不会进静态缓存。

### 5.4 环境变量（Pages 控制台 → Settings → Environment variables）

| 变量 | 值 | 说明 |
|---|---|---|
| `SYNC_TOKEN` | `openssl rand -hex 32` | 同步接口密钥 |
| `DATABASE_URL` | （本地开发用） | 沙箱 SQLite 路径，线上可留空 |

### 5.5 首次导入数据

本地跑一次全量种子 → 导出 → 灌入 D1：

```bash
# 本地：抓取 + 归一化 + 全量导入（scripts/seed-db.ts 沙箱流程）
# 然后 D1 直灌（也可让线上 /api/sync 走一次 items 推送）
wrangler d1 execute hebei-tariff --remote --command "SELECT COUNT(*) FROM Tariff;"
```

或最简方式：先把 `SYNC_API_URL`/`SYNC_TOKEN` 配好，手动触发一次 workflow_dispatch，让 GitHub Actions 把第一次全量数据推上去（diff 引擎自动判全量为 ADDED）。

### 5.6 GitHub Actions Secrets（仓库 Settings → Secrets and variables → Actions）

| Secret | 值 |
|---|---|
| `SYNC_API_URL` | `https://<你的站点>.pages.dev/api/sync` |
| `SYNC_TOKEN` | 与线上环境变量一致的密钥 |

配置完成后，每日 UTC 20:00（北京 04:00）自动抓取推送；也可在 Actions 页面手动 `Run workflow`。

### 5.7 采集出口与节奏（防风控设计）

**WARP 网络出口（四级尝试，前三级均为 Cloudflare WARP 出口）**：

1. **warp-cli TUN 模式**：安装 `cloudflare-warp` apt 包 → 匿名注册 → `warp-cli connect` 建立 TUN 隧道，
   runner 全机流量（含 Chromium 抓取与同步推送）经 WARP 出口。连接验证用 `cdn-cgi/trace` 确认 `warp=on`，
   并按 default → MASQUE → WireGuard 三种协议轮换（各 90 秒）。
2. **warp-cli SOCKS 代理模式**：`warp-cli mode proxy`（本地 `socks5://127.0.0.1:40000`），
   Chromium 走代理抓取，推送 API 走直连。
3. **docker 容器化 WARP**（`caomingjun/warp`）：容器内独立 netns 运行 warp-svc + gost 暴露
   `socks5://127.0.0.1:1080` —— 裸 warp-svc 的 TUN 在 GitHub runner 上数据面可能不通
   （实测控制面 Connected 但 trace 无 warp=on），容器方案自管 TUN 最稳定。
4. **直连兜底**：公示页为公开信息页可直抓；在仓库 **Variables** 设置 `WARP_REQUIRED=true`
   可启用严格模式（WARP 全失败则当日中止，宁缺毋滥）。

要点：

- 每级连接均以「实际出口验证」（trace `warp=on`）为准，不信控制面状态；
- 运行日志打印出口 `ip/loc/colo` 便于审计；失败时自动输出诊断信息（trace / journalctl / docker logs）；
- WARP 免费匿名注册即可（`warp-cli registration new`），无需账号、无需 token、不产生费用；
- 结束时 `if: always()` 断开 warp-cli 并清理 docker 容器。

**真人节奏**（`scripts/scrape.mjs`，防行为风控）：

- 所有等待均为随机区间（`jitter(min, max)`），任意两次运行的节奏都不相同；
- 滚动是「浏览式」而非「机器式」：每轮 1~3 小步滚动（0.8~1.5 视口/步），步间 0.8~1.8s，
  轮间 2~4s，15% 概率出现 4~8s 的「阅读停留」+ 轮末直跳绝对底部（懒加载触发器）；
- 切类型 8~13s、切页签 8~16s、换阶段 8~15s 大间隔随机；
- 视口尺寸每个 worker 独立微随机（宽 1346~1386 × 高 870~930）；偶发鼠标轨迹漂移；UA 主版本微随机。

**多 worker 池与采集范围（2026-09 收敛）：**

- **采集范围仅「个人资费 × 河北省专属」**（不做全网业务与政企业务）：单列表页签
  完整真人节奏遍历约 3~8 分钟，D1 写入与容量压力比原 4 阶段全量版（个人/政企 × 全网/河北）更小；
- scrape.mjs 保留 worker pool 骨架（`SCRAPE_CONCURRENCY` 1~4）：未来恢复多阶段时，
  每阶段为独立工作单元，worker 并行认领，每个 worker 独立 browser context
  （独立 cookie/存储/视口指纹/节奏序列）——相当于同一 WARP 出口（CGNAT 共享 IP）后的
  多个真实用户同时在浏览，属常态流量画像；worker 内部保持完整真人节奏串行遍历；
- 本地验证：`SCRAPE_OUT_DIR=/tmp/pt node scripts/scrape.mjs`；
- 输出仅 `seed/p_h_all.json`（normalize.mjs 仍兼容历史四类文件名前缀，便于回灌旧 artifact）。

**选择器快速冒烟**（约 1 分钟：导航 + 选河北 + 切「河北」页签 + 滚 3 轮 + 抽样 3 张卡片名，不写 seed 文件）：

```bash
SCRAPE_SMOKE=1 node scripts/scrape.mjs   # 本地排查"是选择器坏了还是网络问题"的利器
```

## 六、常见问题

- **公示页改版了怎么办**：Actions 的 sanity check 会因数量骤降直接失败（不推送），此时需要更新 `scripts/scrape.mjs` 里的选择器（`.tariff-item-container` / `.item-name` / `.tips-attr` 等）。
- **WARP 连不上怎么办**：workflow 会重试 3 次（每次最多等 30s 验证 `warp=on`），仍失败则当天中止并在 Actions 页面标红。先本地跑 `SCRAPE_SMOKE=1 node scripts/scrape.mjs` 区分「选择器坏了」还是「网络问题」；本地能抓到而 Actions 失败 → 网络/出口问题；两边都抓不到 → 大概率公示页改版。
- **需要更频繁的更新**：把 `scrape-daily.yml` 的 cron 改成 `0 */6 * * *`（每 6 小时），注意 D1 写入仍只有真实变更行，费用不变；间隔已按真人节奏拉大，频繁抓取请酌情评估对公示页的访问压力。
- **想回看历史每日快照**：Actions artifacts（保留 90 天）就是每日快照；长期归档可把 `seed/tariffs.normalized.json` commit 回仓库或转存 R2。
- **为什么不用 Workers Cron 直接 POST**：可以（省 Actions），但抓取必须跑浏览器，Workers 做不到，所以 Actions 是唯一自动化路径。
