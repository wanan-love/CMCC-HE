/**
 * 种子数据归一化：合并 seed/p_*.json / g_*.json → seed/tariffs.normalized.json（CI 用，不连数据库）
 * 运行: node scripts/normalize.mjs
 * （scripts/seed-db.ts 的 normalize 部分 + 数据库导入是本地沙箱用的全量重灌；
 *   CI 每日任务只做 normalize → POST /api/sync 增量对比）
 *
 * 输入文件（scrape.mjs v3 起按类型分文件）：
 *   p_h_套餐.json / p_h_加装包.json / p_h_营销活动.json / p_h_港澳台_国际资费.json /
 *   p_h_标准资费.json（由 getStandardlist 接口原始表格构造，无「方案编号」字段 →
 *   合成 STD-<md5(名称)> 稳定编号：内容变化 → 同编号 contentHash 变化 = UPDATED 事件）
 *   兼容历史：p_h_all.json（全类型混合）、p_n_x / g_n_x / g_h_x 旧 4 阶段快照。
 *   seed/api/ 下的逆向接口 dump 不参与归一化。
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SEED_DIR = process.env.SCRAPE_OUT_DIR || join(__dirname, '..', 'seed')
const OUT_FILE = join(SEED_DIR, 'tariffs.normalized.json')

/** 解析 "2025年5月15日" → "2025-05-15" */
function parseDate(s) {
  if (!s) return null
  const m = String(s).trim().match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

/** 解析价格："199元/月" → 199；"10元/月（优惠）" → 10 */
function parsePrice(s) {
  if (!s) return null
  const m = String(s).replace(/,/g, '').match(/(\d+(?:\.\d+)?)/)
  if (!m) return null
  const v = parseFloat(m[1])
  return isNaN(v) ? null : v
}

/** 从文件名推断 scope/range（p_h_前缀 = 个人×河北；保留四类前缀兼容历史快照文件） */
function fileMeta(filename) {
  if (filename.startsWith('p_n_')) return { scope: '个人', range: '全网' }
  if (filename.startsWith('p_h_')) return { scope: '个人', range: '河北' }
  if (filename.startsWith('g_n_')) return { scope: '政企', range: '全网' }
  if (filename.startsWith('g_h_')) return { scope: '政企', range: '河北' }
  return null
}

/** 标准资费合成稳定编号：STD-<md5(名称)>（名称重复时追加序号保证唯一） */
function syntheticCode(name, usedCodes) {
  const base = 'STD-' + createHash('md5').update(String(name)).digest('hex').slice(0, 16)
  let code = base
  let i = 2
  while (usedCodes.has(code)) {
    code = `${base}x${i++}`
  }
  return code
}

function normalize() {
  if (!existsSync(SEED_DIR)) {
    console.error(`种子目录不存在: ${SEED_DIR}（请先运行 scripts/scrape.mjs）`)
    process.exit(1)
  }
  // 只认领 p_/g_ 前缀的采集文件（排除 tariffs.normalized.json 自身与 seed/api/ 接口 dump）
  const files = readdirSync(SEED_DIR).filter(
    (f) => f.endsWith('.json') && /^[pg]_[nh]_/.test(f) && !f.includes('normalized')
  )
  const all = new Map()
  const usedCodes = new Set()

  for (const file of files) {
    const meta = fileMeta(file)
    if (!meta) continue
    const raw = JSON.parse(readFileSync(join(SEED_DIR, file), 'utf-8'))
    // 兼容两种输入：agent-browser --json 输出（{data:{result:"[...]"}}）与本仓库 scrape.mjs 的纯数组
    const cards = Array.isArray(raw) ? raw : JSON.parse(raw?.data?.result ?? '[]')

    for (const c of cards) {
      const f = c.fields || {}
      const category = f['资费类型'] || c._sourceType || '其他'
      let code = f['方案编号'] || ''
      if (!code && category === '标准资费') {
        // 标准资费表格行无方案编号 → 以名称哈希合成稳定编号
        code = syntheticCode(c.name, usedCodes)
      }
      if (!code || all.has(code)) continue
      usedCodes.add(code)

      const usage = c.usage || []
      const gray = c.gray || {}

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
  mkdirSync(SEED_DIR, { recursive: true })
  writeFileSync(OUT_FILE, JSON.stringify(list, null, 1), 'utf-8')

  // 汇总日志：按分类统计（便于 CI 观察齐全性）
  const byCat = new Map()
  for (const t of list) byCat.set(t.category, (byCat.get(t.category) || 0) + 1)
  const catLog = [...byCat.entries()].map(([k, v]) => `${k}=${v}`).join('，')
  console.log(`规范化完成: ${list.length} 条资费 → ${OUT_FILE}`)
  console.log(`分类分布: ${catLog}`)
  return list
}

normalize()
