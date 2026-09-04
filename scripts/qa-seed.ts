/**
 * QA 辅助：直接从 seed/tariffs.normalized.json 导入本地数据库（跳过重新归一化）
 * 用途：本地合成全类型数据后的前端渲染 QA；正常灌库仍走 scripts/seed-db.ts
 * 运行: bun scripts/qa-seed.ts
 */
import { db } from '../src/lib/db'
import { readFileSync } from 'fs'
import { join } from 'path'

const OUT_FILE = join(__dirname, '..', 'seed', 'tariffs.normalized.json')

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

async function main() {
  const list: NormalizedTariff[] = JSON.parse(readFileSync(OUT_FILE, 'utf-8'))
  const today = new Date().toISOString().slice(0, 10)

  await db.changeEvent.deleteMany()
  await db.tariff.deleteMany()
  await db.syncRun.deleteMany()
  console.log('已清空旧数据')

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
      message: `QA 全量导入（${list.length} 条，含合成全类型数据）`,
    },
  })

  const BATCH = 500
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list.slice(i, BATCH + i).map((t) => ({
      code: t.code,
      name: t.name,
      category: t.category,
      scope: t.scope,
      range: t.range,
      province: '河北',
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
      status: 'OFFLINE' as const,
    }))
    // 离线日期未到的算在售
    for (const b of batch) {
      if (!b.offlineDate || b.offlineDate >= today) b.status = 'ONLINE'
    }
    await db.tariff.createMany({ data: batch })
    console.log(`  tariffs ${Math.min(i + BATCH, list.length)}/${list.length}`)
  }

  let evCount = 0
  for (let i = 0; i < list.length; i += BATCH) {
    const batch = list
      .slice(i, i + BATCH)
      .filter((t) => t.onlineDate)
      .map((t) => ({
        date: t.onlineDate!,
        type: 'ADDED' as const,
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
  console.log(`  历史事件 ${evCount} 条`)
  console.log('✅ QA Seed 完成')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect?.())
