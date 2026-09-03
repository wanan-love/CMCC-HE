import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseAdvFilters, advTariffWhere } from '@/lib/adv-filter'

export const dynamic = 'force-dynamic'

/**
 * GET /api/upcoming — 即将下线（下线倒计时）
 * 参数: days(默认90，上限365) q(名称/编号搜索) category catIn catOut content priceMin priceMax
 *       sort(date-asc 默认|date-desc|price-asc|price-desc)
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const days = Math.min(365, Math.max(1, parseInt(sp.get('days') || '90', 10)))
    const q = (sp.get('q') || '').trim().slice(0, 64)
    const category = sp.get('category') || ''
    const sort = sp.get('sort') || 'date-asc'
    const adv = parseAdvFilters(sp)
    const today = new Date().toISOString().slice(0, 10)
    const until = new Date()
    until.setDate(until.getDate() + days)
    const untilStr = until.toISOString().slice(0, 10)

    const where: Record<string, unknown> = {
      status: 'ONLINE',
      offlineDate: { gte: today, lte: untilStr },
    }
    // 高级筛选（catIn/catOut/content/priceMin/priceMax；与单选 category 合并）
    Object.assign(where, advTariffWhere(adv, category))
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { code: { contains: q } },
      ]
    }

    const orderMap: Record<string, unknown[]> = {
      'date-asc': [{ offlineDate: 'asc' }],
      'date-desc': [{ offlineDate: 'desc' }],
      'price-asc': [{ priceValue: 'asc' }],
      'price-desc': [{ priceValue: 'desc' }],
    }

    const [items, total] = await Promise.all([
      db.tariff.findMany({
        where,
        orderBy: orderMap[sort] || orderMap['date-asc'],
        take: 1000,
        select: {
          code: true,
          name: true,
          category: true,
          scope: true,
          range: true,
          price: true,
          priceValue: true,
          onlineDate: true,
          offlineDate: true,
          status: true,
        },
      }),
      db.tariff.count({ where }),
    ])

    // 按月份分组
    const byMonth: Record<string, typeof items> = {}
    for (const t of items) {
      const month = (t.offlineDate || '').slice(0, 7)
      if (!byMonth[month]) byMonth[month] = []
      byMonth[month].push(t)
    }

    return NextResponse.json({
      success: true,
      data: { items, byMonth, total, rangeDays: days },
    })
  } catch (e) {
    console.error('upcoming error', e)
    return NextResponse.json({ success: false, error: '下线预告获取失败' }, { status: 500 })
  }
}
