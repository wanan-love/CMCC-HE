import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseMonthRange, parseYearRange } from '@/lib/month-range'
import { parseAdvFilters, advEventWhere } from '@/lib/adv-filter'

export const dynamic = 'force-dynamic'

/**
 * GET /api/timeline — 时间轴数据
 * 参数: days(7/30/90/all) category type(ADDED/REMOVED/UPDATED) source q date month(YYYY-MM) year(YYYY) page
 *       catIn catOut（高级筛选：类型多选 包含/排除）content（套餐内容包含）priceMin priceMax（价格区间，走资费关联）
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const days = sp.get('days') || '30'
    const category = sp.get('category') || ''
    const type = sp.get('type') || ''
    const source = sp.get('source') || ''
    const q = (sp.get('q') || '').trim()
    const date = (sp.get('date') || '').trim()
    const month = (sp.get('month') || '').trim()
    const year = (sp.get('year') || '').trim()
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10))
    const pageSize = 12 // 每页天数
    const adv = parseAdvFilters(sp)

    const where: Record<string, unknown> = {}
    if (type) where.type = type
    if (source) where.source = source
    // 高级筛选（catIn/catOut/content/priceMin/priceMax；与单选 category 深链接合并）
    Object.assign(where, advEventWhere(adv, category))
    if (q) {
      where.OR = [
        { tariffName: { contains: q } },
        { tariffCode: { contains: q } },
        { summary: { contains: q } },
      ]
    }
    const monthRange = parseMonthRange(month)
    const yearRange = parseYearRange(year)
    if (date) {
      where.date = date
    } else if (monthRange) {
      // 月份下钻（洞察图点击）：优先于 year/days 范围
      where.date = monthRange
    } else if (yearRange) {
      // 年度下钻（洞察年度图点击）：优先于 days 范围
      where.date = yearRange
    } else if (days !== 'all') {
      const n = parseInt(days, 10)
      const since = new Date()
      since.setDate(since.getDate() - n)
      where.date = { gte: since.toISOString().slice(0, 10) }
    }

    // 按日期 + 类型分组（准确计数）
    const grouped = await db.changeEvent.groupBy({
      by: ['date', 'type'],
      where,
      _count: { _all: true },
      orderBy: { date: 'desc' },
    })

    // 聚合为按日的 total + byType
    const dayMap = new Map<string, { total: number; byType: Record<string, number> }>()
    for (const g of grouped) {
      let d = dayMap.get(g.date)
      if (!d) {
        d = { total: 0, byType: {} }
        dayMap.set(g.date, d)
      }
      d.total += g._count._all
      d.byType[g.type] = (d.byType[g.type] || 0) + g._count._all
    }
    const dayList = [...dayMap.entries()]
      .map(([date, v]) => ({ date, ...v }))
      .sort((a, b) => b.date.localeCompare(a.date))

    const totalDays = dayList.length
    const pageDays = dayList.slice((page - 1) * pageSize, page * pageSize)

    // 拉取这些日期的事件明细（最多60条防卡顿）
    const dayItems = await Promise.all(
      pageDays.map(async (g) => {
        const events = await db.changeEvent.findMany({
          where: { ...where, date: g.date },
          orderBy: { createdAt: 'desc' },
          take: 60,
        })
        return {
          date: g.date,
          total: g.total,
          byType: g.byType,
          events,
        }
      })
    )

    return NextResponse.json({
      success: true,
      data: {
        days: dayItems,
        totalDays,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(totalDays / pageSize)),
        hasMore: page * pageSize < totalDays,
      },
    })
  } catch (e) {
    console.error('timeline error', e)
    return NextResponse.json({ success: false, error: '时间轴获取失败' }, { status: 500 })
  }
}
