/** 共享类型定义 */

export interface TariffItem {
  code: string
  name: string
  category: string
  scope: string
  range: string
  price: string | null
  priceValue: number | null
  onlineDate: string | null
  offlineDate: string | null
  status: string
  target: string | null
}

export interface TariffDetail extends TariffItem {
  province: string
  channels: string | null
  effective: string | null
  requirement: string | null
  unsubscribe: string | null
  liability: string | null
  usageJson: string
  extraJson: string
  contentHash: string
  firstSeenAt: string
  lastSeenAt: string
  removedAt: string | null
}

export interface ChangeEventItem {
  id: string
  date: string
  type: 'ADDED' | 'REMOVED' | 'UPDATED'
  source: string
  tariffCode: string | null
  tariffName: string
  category: string | null
  changedFields: string | null
  summary: string | null
  createdAt: string
}

export interface TimelineDay {
  date: string
  total: number
  byType: Record<string, number>
  events: ChangeEventItem[]
}

export interface StatsData {
  total: number
  online: number
  offline: number
  today: { added: number; removed: number; updated: number }
  upcomingSoon: number
  upcomingSample: {
    code: string
    name: string
    offlineDate: string | null
    category: string
    price: string | null
  }[]
  lastRun: SyncRun | null
  eventSources: { source: string; _count: { _all: number } }[]
  recentActiveDates: { date: string; count: number }[]
  earliestEventDate: string | null
  serverDate: string
}

export interface SyncRun {
  id: string
  startedAt: string
  finishedAt: string | null
  date: string
  status: string
  source: string
  mode: string
  totalBefore: number
  totalAfter: number
  added: number
  removed: number
  updated: number
  message: string | null
}

export interface SimilarTariff {
  code: string
  name: string
  category: string
  price: string | null
  priceValue: number | null
  onlineDate: string | null
  offlineDate: string | null
  target: string | null
  matchTags?: string[]
}

export interface UsageItem {
  label: string
  value: string
}

export interface ApiResponse<T> {
  success: boolean
  data: T
  error?: string
}

export const CATEGORY_COLORS: Record<string, string> = {
  套餐: 'bg-amber-100 text-amber-800 border-amber-200',
  加装包: 'bg-teal-100 text-teal-800 border-teal-200',
  营销活动: 'bg-pink-100 text-pink-800 border-pink-200',
  港澳台国际: 'bg-cyan-100 text-cyan-800 border-cyan-200',
  '港澳台/国际资费': 'bg-cyan-100 text-cyan-800 border-cyan-200',
  其他: 'bg-stone-100 text-stone-700 border-stone-200',
}

export const TYPE_META: Record<
  string,
  { label: string; icon: string; color: string; bg: string }
> = {
  ADDED: {
    label: '上线',
    icon: '▲',
    color: 'text-emerald-700',
    bg: 'bg-emerald-50 border-emerald-200',
  },
  REMOVED: {
    label: '下线',
    icon: '▼',
    color: 'text-rose-700',
    bg: 'bg-rose-50 border-rose-200',
  },
  UPDATED: {
    label: '变更',
    icon: '●',
    color: 'text-amber-700',
    bg: 'bg-amber-50 border-amber-200',
  },
}

export const SOURCE_LABELS: Record<string, string> = {
  history: '历史重构',
  sync: '同步对比',
}

export function daysUntil(dateStr: string | null): number | null {
  if (!dateStr) return null
  const d = new Date(dateStr + 'T00:00:00')
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return Math.ceil((d.getTime() - now.getTime()) / 86400000)
}

export function formatDateCN(dateStr: string | null): string {
  if (!dateStr) return '—'
  const [y, m, d] = dateStr.split('-')
  return `${y}年${parseInt(m)}月${parseInt(d)}日`
}
