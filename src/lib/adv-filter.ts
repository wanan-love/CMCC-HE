/**
 * 服务端高级筛选解析（时间轴 / 资费库 / 下线倒计时共用）
 * 查询参数：catIn（仅看类型，逗号分隔）、catOut（排除类型）、content（套餐内容包含）、priceMin/priceMax
 */
import type { URLSearchParams } from 'url'

/** 允许参与筛选的合法分类（含抓取历史中两种写法） */
export const FILTER_CATEGORIES = [
  '套餐',
  '加装包',
  '营销活动',
  '港澳台/国际资费',
  '港澳台国际',
]

/** 空集哨兵：in 列表为空时保证「无结果」而非「无条件」 */
const NONE_SENTINEL = '__none__'

export interface AdvFilters {
  catIn: string[]
  catOut: string[]
  content: string
  priceMin: number | null
  priceMax: number | null
}

/** 解析并白名单过滤查询参数 */
export function parseAdvFilters(sp: URLSearchParams): AdvFilters {
  const splitList = (v: string | null) =>
    (v || '')
      .split(',')
      .map((s) => s.trim())
      .filter((c) => FILTER_CATEGORIES.includes(c))
  const num = (v: string | null) => {
    const n = parseFloat((v || '').trim())
    return isNaN(n) || n < 0 ? null : n
  }
  return {
    catIn: splitList(sp.get('catIn')),
    catOut: splitList(sp.get('catOut')),
    content: (sp.get('content') || '').trim().slice(0, 64),
    priceMin: num(sp.get('priceMin')),
    priceMax: num(sp.get('priceMax')),
  }
}

/**
 * 合并分类条件：单选 category（基础筛选/深链接）与多选 in/out（高级筛选）
 * 语义：in 集合 ∩ 排除集合的补集；结果为空集时返回空结果哨兵。
 */
export function mergeCategoryCond(
  baseCategory: string,
  adv: AdvFilters
): { in?: string[]; notIn?: string[] } | null {
  const inSet = new Set(adv.catIn)
  if (baseCategory && FILTER_CATEGORIES.includes(baseCategory)) inSet.add(baseCategory)
  const outSet = new Set(adv.catOut)

  if (inSet.size && outSet.size) {
    const eff = [...inSet].filter((c) => !outSet.has(c))
    return { in: eff.length ? eff : [NONE_SENTINEL] }
  }
  if (inSet.size) return { in: [...inSet] }
  if (outSet.size) return { notIn: [...outSet] }
  return null
}

/** 价格条件片段（Tariff.priceValue / 事件关系过滤共用） */
export function priceCond(adv: AdvFilters): { gte?: number; lte?: number } | null {
  if (adv.priceMin == null && adv.priceMax == null) return null
  const cond: { gte?: number; lte?: number } = {}
  if (adv.priceMin != null) cond.gte = adv.priceMin
  if (adv.priceMax != null) cond.lte = adv.priceMax
  return cond
}

/** Tariff 表的高级筛选 where 片段（与既有 where 浅合并，调用方用 AND 组合） */
export function advTariffWhere(adv: AdvFilters, baseCategory = ''): Record<string, unknown> {
  const w: Record<string, unknown> = {}
  const cat = mergeCategoryCond(baseCategory, adv)
  if (cat) w.category = cat.in ? { in: cat.in } : { notIn: cat.notIn }
  if (adv.content) w.usageJson = { contains: adv.content }
  const pc = priceCond(adv)
  if (pc) w.priceValue = pc
  return w
}

/** ChangeEvent 表的高级筛选 where 片段（价格/内容走 tariff 关系过滤） */
export function advEventWhere(adv: AdvFilters, baseCategory = ''): Record<string, unknown> {
  const w: Record<string, unknown> = {}
  const cat = mergeCategoryCond(baseCategory, adv)
  if (cat) w.category = cat.in ? { in: cat.in } : { notIn: cat.notIn }
  if (adv.content || adv.priceMin != null || adv.priceMax != null) {
    const tariffCond: Record<string, unknown> = {}
    if (adv.content) tariffCond.usageJson = { contains: adv.content }
    const pc = priceCond(adv)
    if (pc) tariffCond.priceValue = pc
    w.tariff = tariffCond
  }
  return w
}
