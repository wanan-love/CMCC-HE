/**
 * 推送归一化数据到线上同步 API（带令牌加密 + 失败重试）
 * 运行: SYNC_API_URL=https://xxx.pages.dev/api/sync SYNC_TOKEN=xxx node scripts/push-sync.mjs
 * （在 GitHub Actions 中由 secrets 注入；本地调试亦可使用）
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_FILE = process.env.SEED_FILE || join(__dirname, '..', 'seed', 'tariffs.normalized.json')
const API_URL = process.env.SYNC_API_URL
const TOKEN = process.env.SYNC_TOKEN

if (!API_URL) {
  console.error('缺少 SYNC_API_URL 环境变量（线上站点的 /api/sync 完整地址）')
  process.exit(1)
}
if (!TOKEN) {
  console.error('缺少 SYNC_TOKEN 环境变量（与线上站点配置的 SYNC_TOKEN 一致）')
  process.exit(1)
}

const items = JSON.parse(readFileSync(SEED_FILE, 'utf-8'))
if (!Array.isArray(items) || items.length === 0) {
  console.error('种子数据为空，中止推送（防止把线上数据全部判为下线）')
  process.exit(1)
}
// 线上基线闸门（2026-09-04 首跑实测后新增）：推送前拉线上在售数作参照，
// 本次抓取数 < 线上在售 × MIN_RATIO 时中止——防止漏抓批次（懒加载截断/出口限流）
// 把大量在线资费误判下线污染时间轴。宁缺毋滥：当天数据缺失可接受，假下线事件不可接受。
// （首次上线线上为空时自动跳过；真下线潮触发闸门时人工核查后可用 MIN_SYNC_RATIO 环境变量临时放行）
const MIN_RATIO = parseFloat(process.env.MIN_SYNC_RATIO || '0.8')
console.log(`待推送 ${items.length} 条（下限比例 ${MIN_RATIO}）`)

try {
  const statsUrl = new URL(API_URL).origin + '/api/stats'
  const res = await fetch(statsUrl, { signal: AbortSignal.timeout(15000) })
  const json = await res.json().catch(() => ({}))
  const online = Number(json?.data?.online ?? 0)
  if (online > 0 && items.length < online * MIN_RATIO) {
    console.error(
      `⛔ 中止推送：本次抓取 ${items.length} 条 < 线上在售 ${online} 条 × ${MIN_RATIO}` +
        `（疑似懒加载批次截断或出口限流导致漏抓；宁缺毋滥防假下线，当日数据留待下次同步补全）`
    )
    process.exit(1)
  }
  console.log(`闸门通过：线上在售 ${online} 条 · 本次抓取 ${items.length} 条`)
} catch (e) {
  console.warn(`⚠️ 线上基线获取失败（${e.message}），跳过闸门直接推送`)
}

const MAX_RETRY = 3
for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ mode: 'items', items }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json.success) {
      throw new Error(`HTTP ${res.status}: ${json.error || res.statusText}`)
    }
    const run = json.data?.run ?? {}
    console.log(
      `✅ 推送成功：抓取 ${items.length} 条 → +${run.added ?? '?'} 上线 / -${run.removed ?? '?'} 下线 / ~${run.updated ?? '?'} 变更；在售 ${run.totalAfter ?? '?'}`
    )
    // 数量骤降告警（仍算成功，但打印显眼提示）
    if (run.totalAfter && run.totalAfter < items.length * MIN_RATIO) {
      console.warn(`⚠️ 警告：线上在售数（${run.totalAfter}）明显低于抓取数（${items.length}），请人工检查公示页改版情况`)
    }
    process.exit(0)
  } catch (e) {
    console.error(`第 ${attempt}/${MAX_RETRY} 次推送失败: ${e.message}`)
    if (attempt < MAX_RETRY) await new Promise((r) => setTimeout(r, 5000 * attempt))
  }
}
process.exit(1)
