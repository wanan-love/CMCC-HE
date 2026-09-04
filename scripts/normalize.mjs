/**
 * 种子数据归一化：合并 seed/*.json → seed/tariffs.normalized.json（CI / GitHub Actions 用，不连数据库）
 * 运行: node scripts/normalize.mjs
 * （scripts/seed-db.ts 的 normalize 部分 + 数据库导入是本地沙箱用的全量重灌；
 *   CI 每日任务只做 normalize → POST /api/sync 增量对比）
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_DIR = process.env.SCRAPE_OUT_DIR || join(__dirname, '..', 'seed')
const OUT_FILE = join(SEED_DIR, 'tariffs.normalized.json')

/** 卡片结构（纯 JS，避免 .mjs 中使用 TS 语法——interface 在 ESM 严格模式下是保留字） */

/** 解析 "2025年5月15日" → "2025-05-15" */
function parseDate(s) {
  if (!s) return null
  const m = s.trim().match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

/** 解析价格："199元/月" → 199；"10元/月（优惠）" → 10 */
function parsePrice(s) {
  if (!s) return null
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/)
  if (!m) return null
  const v = parseFloat(m[1])
  return isNaN(v) ? null : v
}

/** 从文件名推断 scope/range（当前采集范围仅个人×河北 → seed/p_h_all.json；
 *  保留四类前缀兼容历史快照文件，便于回灌旧 artifact 数据） */
function fileMeta(filename) {
  if (filename.startsWith('p_n_')) return { scope: '个人', range: '全网' }
  if (filename.startsWith('p_h_')) return { scope: '个人', range: '河北' }
  if (filename.startsWith('g_n_')) return { scope: '政企', range: '全网' }
  if (filename.startsWith('g_h_')) return { scope: '政企', range: '河北' }
  return { scope: '个人', range: '全网' }
}

function normalize() {
  if (!existsSync(SEED_DIR)) {
    console.error(`种子目录不存在: ${SEED_DIR}（请先运行 scripts/scrape.mjs）`)
    process.exit(1)
  }
  const files = readdirSync(SEED_DIR).filter((f) => f.endsWith('.json') && !f.includes('normalized'))
  const all = new Map()

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(SEED_DIR, file), 'utf-8'))
    // 兼容两种输入：agent-browser --json 输出（{data:{result:"[...]"}}）与本仓库 scrape.mjs 的纯数组
    const cards = Array.isArray(raw)
      ? raw
      : JSON.parse(raw?.data?.result ?? '[]')
    const meta = fileMeta(file)

    for (const c of cards) {
      const f = c.fields || {}
      const code = f['方案编号'] || ''
      if (!code || all.has(code)) continue

      const usage = c.usage || []
      const gray = c.gray || {}
      const category = f['资费类型'] || '其他'

      const hash = createHash('md5').update(JSON.stringify({ f, usage, gray })).digest('hex')

      all.set(code, {
        code,
        name: c.name || f['资费名称'] || code,
        category,
        scope: meta.scope,
        range: meta.range,
        province: '河北',
        price: f['资费标准'] || null,
        priceValue: parsePrice(f['资费标准']),
        onlineDate: parseDate(f['上线日期']),
        offlineDate: parseDate(f['下线日期']),
        target: f['适用范围'] || null,
        channels: f['销售渠道'] || null,
        effective: f['有效期限'] || null,
        requirement: f['在网要求'] || null,
        unsubscribe: f['退订方式'] || null,
        liability: f['违约责任'] || null,
        usageJson: JSON.stringify(usage),
        extraJson: JSON.stringify(gray),
        contentHash: hash,
      })
    }
  }

  const list = [...all.values()]
  writeFileSync(OUT_FILE, JSON.stringify(list, null, 1), 'utf-8')
  console.log(`规范化完成: ${list.length} 条资费 → ${OUT_FILE}`)
  return list
}

normalize()
