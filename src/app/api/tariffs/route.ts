import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseAdvFilters, advTariffWhere } from '@/lib/adv-filter'

export const dynamic = 'force-dynamic'

/**
 * GET /api/tariffs — 资费库列表
 * 参数: status category scope q sort(newest|price-asc|price-desc|offline) priceMin priceMax
 *       catIn catOut（高级筛选：类型多选 包含/排除）content（套餐内容包含）page pageSize
 */
export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams
    const status = sp.get('status') || ''
    const category = sp.get('category') || ''
    const scope = sp.get('scope') || ''
    const q = (sp.get('q') || '').trim()
    const sort = sp.get('sort') || 'newest'
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10))
    const pageSize = Math.min(100, parseInt(sp.get('pageSize') || '12', 10))
    const adv = parseAdvFilters(sp)

    const where: Record<string, unknown> = {}
    if (status) where.status = status
    if (scope) where.scope = scope
    // 高级筛选（catIn/catOut/content/priceMin/priceMax；与单选 category 深链接合并）
    Object.assign(where, advTariffWhere(adv, category))
    if (q) {
      where.OR = [
        { name: { contains: q } },
        { code: { contains: q } },
        { target: { contains: q } },
      ]
    }

    const orderMap: Record<string, unknown[]> = {
      newest: [{ onlineDate: 'desc' }, { firstSeenAt: 'desc' }],
      oldest: [{ onlineDate: 'asc' }],
      'price-asc': [{ priceValue: 'asc' }],
      'price-desc': [{ priceValue: 'desc' }],
      offline: [{ offlineDate: 'asc' }],
    }

    const [items, total] = await Promise.all([
      db.tariff.findMany({
        where,
        orderBy: orderMap[sort] || orderMap.newest,
        skip: (page - 1) * pageSize,
        take: pageSize,
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
          target: true,
        },
      }),
      db.tariff.count({ where }),
    ])

    return NextResponse.json({
      success: true,
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    })
  } catch (e) {
    console.error('tariffs error', e)
    return NextResponse.json({ success: false, error: '资费列表获取失败' }, { status: 500 })
  }
}
