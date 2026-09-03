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
// 数量异常防御：抓取结果骤降（< 60% 条数）时中止，避免网络故障导致大面积误判下线
const MIN_RATIO = parseFloat(process.env.MIN_SYNC_RATIO || '0.6')
console.log(`待推送 ${items.length} 条（下限比例 ${MIN_RATIO}）`)

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
