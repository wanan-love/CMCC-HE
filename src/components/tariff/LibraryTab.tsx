'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Search, ChevronLeft, ChevronRight, Package, ArrowUpRight, ArrowDownRight, Download, Scale, Trash2, Banknote } from 'lucide-react'
import { toast } from 'sonner'
import { useTariffLibrary, type AdvancedFilters, EMPTY_ADVANCED } from './api'
import { AdvancedFilterPopover, AdvancedFilterChips, sanitizeAdvanced } from './AdvancedFilter'
import { CATEGORY_COLORS, daysUntil, type TariffItem } from './types'

const CATEGORIES = ['全部类型', '套餐', '加装包', '营销活动', '港澳台/国际资费']
const SCOPES = ['全部对象', '个人', '政企']
const STATUSES = ['全部状态', '在售', '已下线']
const SORTS = [
  { value: 'newest', label: '最新上线' },
  { value: 'oldest', label: '最早上线' },
  { value: 'price-asc', label: '价格最低' },
  { value: 'price-desc', label: '价格最高' },
  { value: 'offline', label: '最近下线' },
]

// 快捷价格带（元/月）
const PRICE_BANDS: { key: string; label: string; min: string; max: string }[] = [
  { key: '', label: '不限价格', min: '', max: '' },
  { key: 'free', label: '免费', min: '0', max: '0' },
  { key: 'lte29', label: '≤29元', min: '0', max: '29' },
  { key: '30-59', label: '30-59元', min: '30', max: '59' },
  { key: '60-99', label: '60-99元', min: '60', max: '99' },
  { key: '100-199', label: '100-199元', min: '100', max: '199' },
  { key: 'gte200', label: '≥200元', min: '200', max: '' },
]

const MAX_COMPARE = 3

export function LibraryTab({
  onSelectTariff,
  compareCodes,
  onToggleCompare,
  onClearCompare,
  initialPriceBand = '',
  onClearInitialPriceBand,
  initialCategory = '',
  onClearInitialCategory,
}: {
  onSelectTariff: (code: string) => void
  compareCodes: string[]
  onToggleCompare: (code: string) => void
  onClearCompare: () => void
  /** 价格带深链接（URL ?band=，从洞察页 KPI 卡/价格图跳入） */
  initialPriceBand?: string
  /** 用户切换价格带时同步清 URL ?band= */
  onClearInitialPriceBand?: () => void
  /** 分类深链接（URL ?category=，从洞察页饼图扇区跳入；合法分类名才生效） */
  initialCategory?: string
  /** 用户切换分类时同步清 URL ?category= */
  onClearInitialCategory?: () => void
}) {
  const [category, setCategory] = useState(
    CATEGORIES.includes(initialCategory) ? initialCategory : '全部类型'
  )
  const [scope, setScope] = useState('全部对象')
  const [status, setStatus] = useState('全部状态')
  const [sort, setSort] = useState('newest')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  // 合法价格带 key 才生效（防垃圾参数）
  const [priceBand, setPriceBand] = useState(
    PRICE_BANDS.some((b) => b.key === initialPriceBand) ? initialPriceBand : ''
  )
  // 高级筛选（类型多选包含/排除、套餐内容、价格区间）
  const [adv, setAdv] = useState<AdvancedFilters>({ ...EMPTY_ADVANCED })
  const advClean = sanitizeAdvanced(adv)

  /** 切换分类（用户操作或清除）；用户手动切换时同步清 URL 深链接（用户操作优先） */
  const changeCategory = (v: string) => {
    setCategory(v)
    setPage(1)
    if (initialCategory && v !== initialCategory) onClearInitialCategory?.()
  }

  const band = PRICE_BANDS.find((b) => b.key === priceBand) ?? PRICE_BANDS[0]
  // 高级筛选价格区间优先于快捷价格带（两者同时设置时取交集语义：adv 覆盖对应边界）
  const effPriceMin = advClean.priceMin || band.min
  const effPriceMax = advClean.priceMax || band.max

  const { data, isLoading } = useTariffLibrary({
    category: category === '全部类型' ? '' : category,
    scope: scope === '全部对象' ? '' : scope,
    status: status === '全部状态' ? '' : status === '在售' ? 'ONLINE' : 'OFFLINE',
    sort,
    q: query,
    catIn: advClean.catMode === 'include' ? advClean.cats.join(',') : '',
    catOut: advClean.catMode === 'exclude' ? advClean.cats.join(',') : '',
    content: advClean.content,
    priceMin: effPriceMin,
    priceMax: effPriceMax,
    page,
    pageSize: 12,
  })

  const totalPages = data?.totalPages ?? 1

  const exportCsv = () => {
    const sp = new URLSearchParams()
    if (category !== '全部类型') sp.set('category', category)
    if (scope !== '全部对象') sp.set('scope', scope)
    if (status !== '全部状态') sp.set('status', status === '在售' ? 'ONLINE' : 'OFFLINE')
    if (query) sp.set('q', query)
    if (advClean.catMode === 'include' && advClean.cats.length) sp.set('catIn', advClean.cats.join(','))
    if (advClean.catMode === 'exclude' && advClean.cats.length) sp.set('catOut', advClean.cats.join(','))
    if (advClean.content) sp.set('content', advClean.content)
    if (effPriceMin) sp.set('priceMin', effPriceMin)
    if (effPriceMax) sp.set('priceMax', effPriceMax)
    const url = `/api/export?${sp.toString()}`
    const a = document.createElement('a')
    a.href = url
    a.download = ''
    document.body.appendChild(a)
    a.click()
    a.remove()
    toast.success(`正在导出 ${data?.total ?? 0} 条资费到 CSV`)
  }

  return (
    <div className="space-y-4">
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-4 flex flex-wrap items-center gap-2">
          <form
            className="relative flex-1 min-w-[180px]"
            onSubmit={(e) => {
              e.preventDefault()
              setQuery(q)
              setPage(1)
            }}
          >
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-stone-400" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onBlur={() => { setQuery(q); setPage(1) }}
              placeholder="搜索资费名称 / 编号 / 适用范围…"
              className="pl-8 h-8 text-sm"
            />
          </form>

          <Select value={category} onValueChange={changeCategory}>
            <SelectTrigger className="w-[120px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c} className="text-xs">{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={scope} onValueChange={(v) => { setScope(v); setPage(1) }}>
            <SelectTrigger className="w-[100px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPES.map((s) => (
                <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={status} onValueChange={(v) => { setStatus(v); setPage(1) }}>
            <SelectTrigger className="w-[100px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={sort} onValueChange={(v) => { setSort(v); setPage(1) }}>
            <SelectTrigger className="w-[110px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
                <SelectItem key={s.value} value={s.value} className="text-xs">{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs border-teal-300 text-teal-700 hover:bg-teal-50 hover:text-teal-800"
            onClick={exportCsv}
          >
            <Download className="size-3.5" />
            导出 CSV
          </Button>

          <AdvancedFilterPopover
            value={adv}
            onChange={setAdv}
            resultHint={data ? String(data.total) : null}
          />

          {/* 价格带快捷筛选 */}
          <div className="w-full flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-xs text-stone-500 mr-0.5 inline-flex items-center gap-1">
              <Banknote className="size-3.5 text-stone-400" />
              价格带
            </span>
            {PRICE_BANDS.map((b) => (
              <button
                key={b.key || 'any'}
                onClick={() => {
                  setPriceBand(b.key)
                  setPage(1)
                  // 用户手动切换价格带时清 URL 深链接（用户操作优先于 URL 状态）
                  if (initialPriceBand && b.key !== initialPriceBand) onClearInitialPriceBand?.()
                }}
                className={`px-2.5 h-7 text-xs rounded-md border transition-colors ${
                  priceBand === b.key
                    ? 'bg-amber-600 text-white border-amber-600'
                    : 'bg-white text-stone-600 border-stone-200 hover:border-amber-300 hover:text-amber-700'
                }`}
              >
                {b.label}
              </button>
            ))}
            {priceBand && (
              <span className="text-[11px] text-stone-400">
                {data?.total ?? 0} 个结果
              </span>
            )}
          </div>

          {/* 高级筛选生效 chips */}
          <AdvancedFilterChips value={advClean} onChange={setAdv} />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between text-xs text-stone-500 px-1">
        <span className="flex items-center gap-1.5">
          共 {data?.total ?? 0} 条资费
          <span className="text-stone-300">·</span>
          <span className="text-stone-400">勾选卡片右上角可对比（最多 {MAX_COMPARE} 个）</span>
        </span>
        <span>
          第 {page} / {totalPages} 页
        </span>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      ) : !data || data.items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-stone-500">
            <Package className="mx-auto size-8 text-stone-300 mb-2" />
            没有符合条件的资费
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {data.items.map((t) => (
            <TariffCard
              key={t.code}
              tariff={t}
              selected={compareCodes.includes(t.code)}
              selectable={compareCodes.includes(t.code) || compareCodes.length < MAX_COMPARE}
              onToggleCompare={() => onToggleCompare(t.code)}
              onClick={() => onSelectTariff(t.code)}
            />
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 py-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="size-4" /> 上一页
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            下一页 <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

function TariffCard({
  tariff,
  selected,
  selectable,
  onToggleCompare,
  onClick,
}: {
  tariff: TariffItem
  selected: boolean
  selectable: boolean
  onToggleCompare: () => void
  onClick: () => void
}) {
  const countdown = daysUntil(tariff.offlineDate)
  const isOffline = tariff.status === 'OFFLINE'

  return (
    <Card
      className={`relative border shadow-sm hover:shadow-md transition-all group ${
        selected
          ? 'border-emerald-400 ring-2 ring-emerald-200 bg-emerald-50/40'
          : 'border-stone-200 hover:border-stone-300 bg-white'
      }`}
    >
      <CardContent
        className="p-4 space-y-2.5 cursor-pointer"
        onClick={onClick}
      >
        {/* 对比勾选按钮 */}
        <button
          aria-label={selected ? '移出对比' : '加入对比'}
          title={selectable || selected ? (selected ? '移出对比' : '加入对比') : `最多对比 ${MAX_COMPARE} 个`}
          disabled={!selectable && !selected}
          onClick={(e) => {
            e.stopPropagation()
            if (selectable || selected) {
              if (!selected && !selectable) return
              onToggleCompare()
            }
          }}
          className={`absolute right-3 top-3 size-5 rounded-md border flex items-center justify-center transition-all z-10 ${
            selected
              ? 'bg-emerald-600 border-emerald-600 text-white'
              : selectable
                ? 'border-stone-300 text-transparent group-hover:border-emerald-400 group-hover:text-emerald-300 bg-white/90'
                : 'border-stone-200 text-transparent bg-stone-50 opacity-50 cursor-not-allowed'
          }`}
        >
          <svg viewBox="0 0 12 10" className="size-3" fill="none">
            <path d="M1 5.5L4.5 9L11 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <div className="flex items-start justify-between gap-2 pr-7">
          <div className="flex flex-wrap gap-1.5 items-center">
            <Badge variant="outline" className={`text-[10px] ${CATEGORY_COLORS[tariff.category] ?? CATEGORY_COLORS['其他']}`}>
              {tariff.category}
            </Badge>
            <Badge variant="outline" className="text-[10px] bg-stone-50 text-stone-500 border-stone-200">
              {tariff.scope}·{tariff.range}
            </Badge>
            {isOffline && (
              <Badge className="text-[10px] bg-rose-100 text-rose-700 border border-rose-200 hover:bg-rose-100">
                已下线
              </Badge>
            )}
            {!isOffline && countdown !== null && countdown <= 30 && (
              <Badge variant="outline" className="text-[10px] bg-amber-50 text-amber-700 border-amber-200">
                {countdown}天后下线
              </Badge>
            )}
          </div>
          <div className="text-right shrink-0">
            <div className={`text-lg font-bold ${isOffline ? 'text-stone-400 line-through' : 'text-emerald-700'}`}>
              {tariff.price || '—'}
            </div>
          </div>
        </div>

        <h3 className="font-medium text-sm text-stone-800 group-hover:text-emerald-700 transition-colors line-clamp-2">
          {tariff.name}
        </h3>

        <div className="flex items-center justify-between text-[11px] text-stone-400">
          <span className="font-mono">{tariff.code}</span>
          <div className="flex items-center gap-2">
            {tariff.onlineDate && (
              <span className="inline-flex items-center gap-0.5">
                <ArrowUpRight className="size-3 text-emerald-500" />
                {tariff.onlineDate}
              </span>
            )}
            {tariff.offlineDate && (
              <span className="inline-flex items-center gap-0.5">
                <ArrowDownRight className="size-3 text-rose-400" />
                {tariff.offlineDate.slice(2)}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** 对比操作浮动条：移动端全宽底部条（两行自适应），桌面端浮动胶囊 */
export function CompareBar({
  codes,
  onClear,
  onCompare,
  onRemove,
}: {
  codes: string[]
  onClear: () => void
  onCompare: () => void
  onRemove: (code: string) => void
}) {
  if (codes.length === 0) return null
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-50 animate-in slide-in-from-bottom-4 fade-in duration-300
        pb-[env(safe-area-inset-bottom)]
        sm:inset-x-auto sm:bottom-4 sm:left-1/2 sm:-translate-x-1/2 sm:pb-0"
    >
      <div
        className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-stone-900/95 backdrop-blur text-white
          rounded-none border-t sm:rounded-2xl sm:border pl-3 sm:pl-4 pr-2 py-2 shadow-xl border-stone-700"
      >
        <div className="flex items-center gap-2 order-1">
          <Scale className="size-4 text-emerald-400 shrink-0" />
          <span className="text-xs text-stone-200 whitespace-nowrap">
            已选 <b className="text-emerald-400">{codes.length}</b>/{MAX_COMPARE}
          </span>
        </div>
        <div
          className="order-3 sm:order-2 w-full sm:w-auto flex items-center gap-1 max-w-full sm:max-w-[40vw]
            overflow-x-auto py-0.5 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
        >
          {codes.map((c) => (
            <button
              key={c}
              onClick={() => onRemove(c)}
              title={`移除 ${c}`}
              className="shrink-0 inline-flex items-center gap-1 text-[10px] bg-stone-800 hover:bg-stone-700 border border-stone-600 rounded-full px-2 py-1 transition-colors"
            >
              <span className="font-mono">{c.length > 10 ? c.slice(0, 10) + '…' : c}</span>
              <Trash2 className="size-2.5 text-stone-400" />
            </button>
          ))}
        </div>
        <div className="ml-auto sm:ml-0 order-2 sm:order-3 flex items-center gap-1">
          <Button
            size="sm"
            className="h-7 text-xs bg-emerald-600 hover:bg-emerald-700 rounded-full px-4"
            disabled={codes.length < 2}
            onClick={onCompare}
          >
            {codes.length < 2 ? '至少选 2 个' : `开始对比（${codes.length}）`}
          </Button>
          <button
            onClick={onClear}
            className="text-stone-400 hover:text-white text-xs px-2"
            title="清空选择"
          >
            清空
          </button>
        </div>
      </div>
    </div>
  )
}
