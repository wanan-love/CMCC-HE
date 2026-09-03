/**
 * 种子数据处理：合并抓取的 JSON → 规范化 → 导入数据库
 * 运行: bun scripts/seed-db.ts
 */
import { db } from '../src/lib/db'
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

const SEED_DIR = join(__dirname, '..', 'seed')
const OUT_FILE = join(SEED_DIR, 'tariffs.normalized.json')

interface RawCard {
  name: string
  fields: Record<string, string>
  usage: { label: string; value: string }[]
  gray: Record<string, string>
}

interface NormalizedTariff {
  code: string
  name: string
  category: string
  scope: string
  range: string
  price: string | null
  priceValue: number | null
  onlineDate: string | null
  offlineDate: string | null
  target: string | null
  channels: string | null
  effective: string | null
  requirement: string | null
  unsubscribe: string | null
  liability: string | null
  usageJson: string
  extraJson: string
  contentHash: string
}

/** 解析 "2025年5月15日" → "2025-05-15" */
function parseDate(s?: string): string | null {
  if (!s) return null
  const m = s.trim().match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

/** 解析价格："199元/月" → 199；"10元/月（优惠）" → 10 */
function parsePrice(s?: string): number | null {
  if (!s) return null
  const m = s.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/)
  if (!m) return null
  const v = parseFloat(m[1])
  return isNaN(v) ? null : v
}

/** 从文件名推断 scope/range */
function fileMeta(filename: string): { scope: string; range: string } {
  if (filename.startsWith('p_n_')) return { scope: '个人', range: '全网' }
  if (filename.startsWith('p_h_')) return { scope: '个人', range: '河北' }
  if (filename.startsWith('g_n_')) return { scope: '政企', range: '全网' }
  if (filename.startsWith('g_h_')) return { scope: '政企', range: '河北' }
  return { scope: '个人', range: '全网' }
}

function normalize(): NormalizedTariff[] {
  const files = readdirSync(SEED_DIR).filter(
    (f) => f.endsWith('.json') && !f.includes('normalized')
  )
  const all = new Map<string, NormalizedTariff>()

  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(SEED_DIR, file), 'utf-8'))
    const cards: RawCard[] = JSON.parse(raw.data?.result ?? '[]')
    const meta = fileMeta(file)

    for (const c of cards) {
      const f = c.fields || {}
      const code = f['方案编号'] || ''
      if (!code || all.has(code)) continue

      const usage = c.usage || []
      const gray = c.gray || {}
      const category = f['资费类型'] || '其他'

      const hash = createHash('md5')
        .update(JSON.stringify({ f, usage, gray }))
        .digest('hex')

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
  if (!existsSync(SEED_DIR)) mkdirSync(SEED_DIR)
  writeFileSync(OUT_FILE, JSON.stringify(list, null, 1), 'utf-8')
  console.log(`规范化完成: ${list.length} 条资费 → ${OUT_FILE}`)
  return list
}

async function seed(list: NormalizedTariff[]) {
  const today = new Date().toISOString().slice(0, 10)

  // 清空旧数据（可重复执行）
  await db.changeEvent.deleteMany()
  await db.tariff.deleteMany()
  await db.syncRun.deleteMany()
  console.log('已清空旧数据')

  // 1. 同步运行记录
  const run = await db.syncRun.create({
    data: {
      date: today,
      status: 'SUCCESS',
      source: 'scraper',
      mode: 'full',
      totalBefore: 0,
      totalAfter: list.length,
      added: list.length,
      removed: 0,
      updated: 0,
      finishedAt: new Date(),
      message: `首次全量导入：来自资费公示页浏览器抓取（${list.length} 条）`,
    },
  })

  // 2. 批量插入 Tariff
  const BATCH = 500
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, i + BATCH).map((t) => ({
      code: t.code,
      name: t.name,
      category: t.category,
      scope: t.scope,
      range: t.range,
      province: t.province,
      price: t.price,
      priceValue: t.priceValue,
      onlineDate: t.onlineDate,
      offlineDate: t.offlineDate,
      target: t.target,
      channels: t.channels,
      effective: t.effective,
      requirement: t.requirement,
      unsubscribe: t.unsubscribe,
      liability: t.liability,
      usageJson: t.usageJson,
      extraJson: t.extraJson,
      contentHash: t.contentHash,
      firstSeenAt: t.onlineDate ? new Date(t.onlineDate + 'T08:00:00Z') : new Date(),
      lastSeenAt: new Date(),
      status: 'ONLINE',
    }))
    await db.tariff.createMany({ data: batch })
    console.log(`  tariffs ${Math.min(i + BATCH, list.length)}/${list.length}`)
  }

  // 3. 历史事件：以真实"上线日期"重构时间轴
  let evCount = 0
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list
      .slice(i, i + BATCH)
      .filter((t) => t.onlineDate)
      .map((t) => ({
        date: t.onlineDate!,
        type: 'ADDED',
        source: 'history',
        tariffCode: t.code,
        tariffName: t.name,
        category: t.category,
        summary: `「${t.name}」上线（${t.price ?? '价格未公示'}）`,
        syncRunId: run.id,
      }))
    if (batch.length) {
      await db.changeEvent.createMany({ data: batch })
      evCount += batch.length
    }
  }
  console.log(`  历史事件 ${evCount} 条（按真实上线日期重构）`)

  console.log('✅ Seed 完成')
}

async function main() {
  const list = normalize()
  await seed(list)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect?.())
