import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ALL_CATEGORIES } from '@/components/tariff/types'

export const dynamic = 'force-dynamic'

/** GET /api/insights — 数据洞察（图表数据） */
export async function GET() {
  try {
    // 分类分布
    const byCategory = await db.tariff.groupBy({
      by: ['category'],
      _count: { _all: true },
      orderBy: { _count: { category: 'desc' } },
    })

    // 适用范围分布
    const byScope = await db.tariff.groupBy({
      by: ['scope'],
      _count: { _all: true },
    })

    // 近24个月每月新上线数量
    const since = new Date()
    since.setMonth(since.getMonth() - 24)
    const sinceStr = since.toISOString().slice(0, 10)
    const recentAdded = await db.changeEvent.findMany({
      where: { type: 'ADDED', source: 'history', date: { gte: sinceStr } },
      select: { date: true },
    })
    const monthly: Record<string, number> = {}
    for (const e of recentAdded) {
      const m = e.date.slice(0, 7)
      monthly[m] = (monthly[m] || 0) + 1
    }

    // 价格分布（套餐类）
    const priced = await db.tariff.findMany({
      where: { priceValue: { not: null }, category: '套餐' },
      select: { priceValue: true },
    })
    const buckets: Record<string, number> = {
      '0-19元': 0,
      '20-49元': 0,
      '50-99元': 0,
      '100-199元': 0,
      '200-499元': 0,
      '500元以上': 0,
    }
    for (const t of priced) {
      const v = t.priceValue!
      if (v < 20) buckets['0-19元']++
      else if (v < 50) buckets['20-49元']++
      else if (v < 100) buckets['50-99元']++
      else if (v < 200) buckets['100-199元']++
      else if (v < 500) buckets['200-499元']++
      else buckets['500元以上']++
    }

    // 价格分布（加装包类，价格带更细：加装包普遍便宜）
    const pricedAddons = await db.tariff.findMany({
      where: { priceValue: { not: null }, category: '加装包' },
      select: { priceValue: true },
    })
    const addonBuckets: Record<string, number> = {
      '0元': 0,
      '1-9元': 0,
      '10-19元': 0,
      '20-49元': 0,
      '50-99元': 0,
      '100元以上': 0,
    }
    for (const t of pricedAddons) {
      const v = t.priceValue!
      if (v === 0) addonBuckets['0元']++
      else if (v < 10) addonBuckets['1-9元']++
      else if (v < 20) addonBuckets['10-19元']++
      else if (v < 50) addonBuckets['20-49元']++
      else if (v < 100) addonBuckets['50-99元']++
      else addonBuckets['100元以上']++
    }

    // 上线年份分布
    const allOnlineDates = await db.tariff.findMany({
      where: { onlineDate: { not: null } },
      select: { onlineDate: true },
    })
    const byYear: Record<string, number> = {}
    for (const t of allOnlineDates) {
      const y = (t.onlineDate || '').slice(0, 4)
      if (y >= '2016') byYear[y] = (byYear[y] || 0) + 1
    }

    // 近 24 个月上线/下线/变更对比（排除演示事件，只统计真实数据；
    // 原 12 个月三序列图与 24 个月单序列图合并为这一张，消除同数据双图冗余）
    const since24m = new Date()
    since24m.setMonth(since24m.getMonth() - 24)
    since24m.setDate(1)
    const since24mStr = since24m.toISOString().slice(0, 10)
    const recentEvents = await db.changeEvent.findMany({
      where: { date: { gte: since24mStr }, source: { not: 'demo' } },
      select: { date: true, type: true },
    })
    const changesByMonth: Record<string, { added: number; removed: number; updated: number }> = {}
    for (const e of recentEvents) {
      const m = e.date.slice(0, 7)
      if (!changesByMonth[m]) changesByMonth[m] = { added: 0, removed: 0, updated: 0 }
      if (e.type === 'ADDED') changesByMonth[m].added++
      else if (e.type === 'REMOVED') changesByMonth[m].removed++
      else if (e.type === 'UPDATED') changesByMonth[m].updated++
    }
    const monthlyChanges = Object.entries(changesByMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, v]) => ({ month: m, ...v }))

    // 近 24 个月新上线分类构成（按分类分列，看结构变化；与上面 monthlyChanges 同窗口同口径）
    const since24mCat = new Date()
    since24mCat.setMonth(since24mCat.getMonth() - 24)
    since24mCat.setDate(1)
    const since24mCatStr = since24mCat.toISOString().slice(0, 10)
    // 分类全集（含标准资费等全类型；与前端 ALL_CATEGORIES 同源，另兼容历史两种写法）
    const CATEGORY_KEYS = [...ALL_CATEGORIES, '港澳台国际']
    const emptyCatRow = () => Object.fromEntries(CATEGORY_KEYS.map((c) => [c, 0]))
    const addedWithCategory = await db.changeEvent.findMany({
      where: { date: { gte: since24mCatStr }, type: 'ADDED', source: { not: 'demo' } },
      select: { date: true, category: true },
    })
    const catByMonth: Record<string, Record<string, number>> = {}
    for (const e of addedWithCategory) {
      const m = e.date.slice(0, 7)
      if (!catByMonth[m]) catByMonth[m] = emptyCatRow()
      // 未知/空分类跳过（不纳入构成图，避免误归）
      if (!CATEGORY_KEYS.includes(e.category ?? '')) continue
      catByMonth[m][e.category!]++
    }
    const categoryMonthly = Object.entries(catByMonth)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([m, v]) => ({ month: m, ...v }))

    // 价格统计（套餐 vs 加装包：中位价、免费数量）
    const priceStats = await computePriceStats()

    // 价格带 name → 资费库 PRICE_BANDS key 映射（下钻用）
    const planKeyMap: Record<string, string> = {
      '0-19元': 'lte29',
      '20-49元': '30-59',
      '50-99元': '60-99',
      '100-199元': '100-199',
      '200-499元': 'gte200',
      '500元以上': 'gte200',
    }
    const addonKeyMap: Record<string, string> = {
      '0元': 'free',
      '1-9元': 'lte29',
      '10-19元': 'lte29',
      '20-49元': '30-59',
      '50-99元': '60-99',
      '100元以上': 'gte200',
    }

    return NextResponse.json({
      success: true,
      data: {
        byCategory: byCategory.map((c) => ({ name: c.category, value: c._count._all })),
        byScope: byScope.map((s) => ({ name: s.scope, value: s._count._all })),
        monthly: Object.entries(monthly)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([m, count]) => ({ month: m, count })),
        monthlyChanges,
        priceBuckets: Object.entries(buckets).map(([name, count]) => ({
          name,
          count,
          key: planKeyMap[name] ?? '',
        })),
        addonPriceBuckets: Object.entries(addonBuckets).map(([name, count]) => ({
          name,
          count,
          key: addonKeyMap[name] ?? '',
        })),
        categoryMonthly,
        priceStats,
        byYear: Object.entries(byYear)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([year, count]) => ({ year, count })),
      },
    })
  } catch (e) {
    console.error('insights error', e)
    return NextResponse.json({ success: false, error: '洞察数据获取失败' }, { status: 500 })
  }
}

/** 价格统计：套餐/加装包的中位价、免费数、有价数 */
async function computePriceStats() {
  const [plans, addons, allFree] = await Promise.all([
    db.tariff.findMany({
      where: { category: '套餐', priceValue: { not: null } },
      select: { priceValue: true },
    }),
    db.tariff.findMany({
      where: { category: '加装包', priceValue: { not: null } },
      select: { priceValue: true },
    }),
    // 全分类 0 元资费总数（与资费库价格带「免费」口径一致，下钻数字才能对得上）
    db.tariff.count({ where: { priceValue: 0 } }),
  ])
  const median = (vals: number[]) => {
    if (vals.length === 0) return null
    const s = [...vals].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
  }
  return {
    planMedian: median(plans.map((p) => p.priceValue!)),
    planFree: plans.filter((p) => p.priceValue === 0).length,
    planPriced: plans.length,
    addonMedian: median(addons.map((p) => p.priceValue!)),
    addonFree: addons.filter((p) => p.priceValue === 0).length,
    addonPriced: addons.length,
    totalFree: allFree,
  }
}
