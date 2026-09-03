import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

/** GET /api/stats — 总览统计 */
export async function GET() {
  try {
    const today = new Date().toISOString().slice(0, 10)

    const [total, online, offline, todayEvents, lastRun, recentDates, earliestEvent] = await Promise.all([
      db.tariff.count(),
      db.tariff.count({ where: { status: 'ONLINE' } }),
      db.tariff.count({ where: { status: 'OFFLINE' } }),
      // 今日 KPI 排除演示事件，保证真实变更统计
      db.changeEvent.findMany({
        where: { date: today, source: { not: 'demo' } },
        select: { type: true },
      }),
      // 最后一次成功更新（采集与展示分离：失败/进行中的运行不算「最后更新」）
      db.syncRun.findFirst({ where: { status: 'SUCCESS' }, orderBy: { startedAt: 'desc' } }),
      db.changeEvent.groupBy({
        by: ['date'],
        _count: { _all: true },
        orderBy: { date: 'desc' },
        take: 5,
      }),
      // 最早事件日期（时间轴翻月下界）
      db.changeEvent.findFirst({ orderBy: { date: 'asc' }, select: { date: true } }),
    ])

    const todayAdded = todayEvents.filter((e) => e.type === 'ADDED').length
    const todayRemoved = todayEvents.filter((e) => e.type === 'REMOVED').length
    const todayUpdated = todayEvents.filter((e) => e.type === 'UPDATED').length

    // 90天内即将下线（真实总数）
    const in90 = new Date()
    in90.setDate(in90.getDate() + 90)
    const in90Str = in90.toISOString().slice(0, 10)
    const upcomingCount = await db.tariff.count({
      where: {
        status: 'ONLINE',
        offlineDate: { gte: today, lte: in90Str },
      },
    })
    const upcoming = await db.tariff.findMany({
      where: {
        status: 'ONLINE',
        offlineDate: { gte: today, lte: in90Str },
      },
      orderBy: { offlineDate: 'asc' },
      take: 8,
      select: { code: true, name: true, offlineDate: true, category: true, price: true },
    })

    const eventSources = await db.changeEvent.groupBy({
      by: ['source'],
      _count: { _all: true },
    })

    return NextResponse.json({
      success: true,
      data: {
        total,
        online,
        offline,
        today: { added: todayAdded, removed: todayRemoved, updated: todayUpdated },
        upcomingSoon: upcomingCount,
        upcomingSample: upcoming,
        lastRun,
        eventSources,
        recentActiveDates: recentDates.map((d) => ({ date: d.date, count: d._count._all })),
        earliestEventDate: earliestEvent?.date ?? null,
        serverDate: today,
      },
    })
  } catch (e) {
    console.error('stats error', e)
    return NextResponse.json({ success: false, error: '统计获取失败' }, { status: 500 })
  }
}
