'use client'

import { useQuery } from '@tanstack/react-query'
import type {
  ApiResponse,
  StatsData,
  TimelineDay,
  TariffItem,
  TariffDetail,
  ChangeEventItem,
  SyncRun,
  SimilarTariff,
} from './types'

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const json = (await res.json()) as ApiResponse<T>
  if (!json.success) throw new Error(json.error || '请求失败')
  return json.data
}

export function useStats() {
  return useQuery<StatsData>({
    queryKey: ['stats'],
    queryFn: () => fetchJson<StatsData>('/api/stats'),
    refetchInterval: 60_000,
  })
}

export interface TimelineParams {
  days?: string
  category?: string
  type?: string
  source?: string
  q?: string
  date?: string
  month?: string
  /** 年度下钻（YYYY，洞察年度图点击写入） */
  year?: string
  /** 高级筛选：类型多选（仅看） */
  catIn?: string
  /** 高级筛选：类型多选（排除） */
  catOut?: string
  /** 高级筛选：套餐内容包含 */
  content?: string
  /** 高级筛选：价格区间 */
  priceMin?: string
  priceMax?: string
  page?: number
}

export function useTimeline(params: TimelineParams) {
  const sp = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v) sp.set(k, String(v))
  })
  return useQuery<{
    days: TimelineDay[]
    totalDays: number
    page: number
    totalPages: number
  }>({
    queryKey: ['timeline', params],
    queryFn: () =>
      fetchJson(`/api/timeline?${sp.toString()}`),
  })
}

export interface HeatmapItem {
  date: string
  total: number
  added: number
  removed: number
  updated: number
}

export function useHeatmap(days = 180) {
  return useQuery<{ items: HeatmapItem[]; days: number }>({
    queryKey: ['heatmap', days],
    queryFn: () => fetchJson(`/api/timeline/heatmap?days=${days}`),
    staleTime: 300_000,
  })
}

export interface LibraryParams {
  status?: string
  category?: string
  scope?: string
  q?: string
  sort?: string
  priceMin?: string
  priceMax?: string
  page?: number
  pageSize?: number
}

export function useTariffLibrary(params: LibraryParams) {
  const sp = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v) sp.set(k, String(v))
  })
  return useQuery<{
    items: TariffItem[]
    total: number
    page: number
    totalPages: number
  }>({
    queryKey: ['tariffs', params],
    queryFn: () => fetchJson(`/api/tariffs?${sp.toString()}`),
  })
}

export function useTariffDetail(code: string | null) {
  return useQuery<{ tariff: TariffDetail; events: ChangeEventItem[]; similar: SimilarTariff[] }>({
    queryKey: ['tariff', code],
    queryFn: () => fetchJson(`/api/tariffs/${code}`),
    enabled: !!code,
  })
}

/** 高级筛选参数（时间轴 / 资费库 / 下线倒计时共用） */
export interface AdvancedFilters {
  /** 资费类型多选（勾选列表） */
  cats: string[]
  /** cats 的作用模式：include = 仅保留勾选类型；exclude = 排除勾选类型 */
  catMode: 'include' | 'exclude'
  /** 套餐内容包含关键词（匹配 usageJson） */
  content: string
  /** 价格区间下限（元/月） */
  priceMin: string
  /** 价格区间上限（元/月） */
  priceMax: string
}

export const EMPTY_ADVANCED: AdvancedFilters = {
  cats: [],
  catMode: 'include',
  content: '',
  priceMin: '',
  priceMax: '',
}

export function advancedCount(f: AdvancedFilters): number {
  let n = 0
  if (f.cats.length) n++
  if (f.content.trim()) n++
  if (f.priceMin.trim() || f.priceMax.trim()) n++
  return n
}

/** 高级筛选 → URL 查询参数（catIn / catOut / content / priceMin / priceMax） */
export function advancedToParams(f: AdvancedFilters, sp: URLSearchParams) {
  if (f.cats.length) {
    sp.set(f.catMode === 'include' ? 'catIn' : 'catOut', f.cats.join(','))
  }
  if (f.content.trim()) sp.set('content', f.content.trim())
  if (f.priceMin.trim()) sp.set('priceMin', f.priceMin.trim())
  if (f.priceMax.trim()) sp.set('priceMax', f.priceMax.trim())
}

export function useUpcoming(params: {
  days?: number
  q?: string
  category?: string
  catIn?: string
  catOut?: string
  content?: string
  priceMin?: string
  priceMax?: string
  sort?: string
}) {
  const sp = new URLSearchParams()
  Object.entries(params).forEach(([k, v]) => {
    if (v) sp.set(k, String(v))
  })
  return useQuery<{
    items: TariffItem[]
    byMonth: Record<string, TariffItem[]>
    total: number
    rangeDays: number
  }>({
    queryKey: ['upcoming', params],
    queryFn: () => fetchJson(`/api/upcoming?${sp.toString()}`),
  })
}

export interface InsightsData {
  byCategory: { name: string; value: number }[]
  byScope: { name: string; value: number }[]
  monthly: { month: string; count: number }[]
  monthlyChanges: { month: string; added: number; removed: number; updated: number }[]
  priceBuckets: { name: string; count: number; key: string }[]
  addonPriceBuckets: { name: string; count: number; key: string }[]
  categoryMonthly: {
    month: string
    套餐: number
    加装包: number
    营销活动: number
    '港澳台/国际资费': number
  }[]
  priceStats: {
    planMedian: number | null
    planFree: number
    planPriced: number
    addonMedian: number | null
    addonFree: number
    addonPriced: number
    /** 全分类 0 元资费总数（与资费库「免费」价格带口径一致） */
    totalFree: number
  }
  byYear: { year: string; count: number }[]
}

export function useInsights() {
  return useQuery<InsightsData>({
    queryKey: ['insights'],
    queryFn: () => fetchJson<InsightsData>('/api/insights'),
  })
}

/** 更新记录（按需加载：popover 打开时才请求，避免常驻 30s 轮询） */
export function useSyncRuns(enabled = true) {
  return useQuery<{ runs: SyncRun[] }>({
    queryKey: ['sync-runs'],
    queryFn: () => fetchJson<{ runs: SyncRun[] }>('/api/sync/runs'),
    refetchInterval: 30_000,
    enabled,
  })
}

