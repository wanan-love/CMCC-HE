import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/**
 * GET /api/timeline/heatmap — 时间轴热力图数据（每日事件密度）
 * 参数: days 默认 180
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const days = Math.min(730, parseInt(sp.get('days') || '180', 10))
    const since = new Date()
    since.setDate(since.getDate() - days)
    const sinceStr = since.toISOString().slice(0, 10)

    const grouped = await db.changeEvent.groupBy({
      by: ['date', 'type'],
      where: { date: { gte: sinceStr } },
      _count: { _all: true },
    })

    const byDate: Record<string, { total: number; added: number; removed: number; updated: number }> = {}
    for (const g of grouped) {
      if (!byDate[g.date]) byDate[g.date] = { total: 0, added: 0, removed: 0, updated: 0 }
      const d = byDate[g.date]
      d.total += g._count._all
      if (g.type === 'ADDED') d.added += g._count._all
      else if (g.type === 'REMOVED') d.removed += g._count._all
      else if (g.type === 'UPDATED') d.updated += g._count._all
    }

    const items = Object.entries(byDate)
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => a.date.localeCompare(b.date))

    return NextResponse.json({
      success: true,
      data: { items, days },
    })
  } catch (e) {
    console.error('heatmap error', e)
    return NextResponse.json({ success: false, error: '热力图获取失败' }, { status: 500 })
  }
}
