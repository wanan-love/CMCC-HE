'use client'

import { useState } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Timer, CalendarClock, Flame, Eye, Binoculars, TrendingDown, Search, RotateCcw, PackageSearch } from 'lucide-react'
import { useUpcoming, type AdvancedFilters, advancedCount, EMPTY_ADVANCED } from './api'
import { AdvancedFilterPopover, AdvancedFilterChips, sanitizeAdvanced } from './AdvancedFilter'
import { CATEGORY_COLORS, ALL_CATEGORIES, formatDateCN, type TariffItem } from './types'

const UPCOMING_CATEGORIES = ['全部类型', ...ALL_CATEGORIES]

const DAY_RANGES = [
  { value: 30, label: '30天' },
  { value: 90, label: '90天' },
  { value: 180, label: '半年' },
  { value: 365, label: '一年' },
]

const SORTS = [
  { value: 'date-asc', label: '最早下线' },
  { value: 'date-desc', label: '最晚下线' },
  { value: 'price-asc', label: '价格最低' },
  { value: 'price-desc', label: '价格最高' },
]

export function UpcomingTab({ onSelectTariff }: { onSelectTariff: (code: string) => void }) {
  const [category, setCategory] = useState('全部类型')
  const [days, setDays] = useState(90)
  const [sort, setSort] = useState('date-asc')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [adv, setAdv] = useState<AdvancedFilters>({ ...EMPTY_ADVANCED })
  const advClean = sanitizeAdvanced(adv)

  const { data, isLoading } = useUpcoming({
    days,
    sort,
    q: query,
    category: category === '全部类型' ? '' : category,
    catIn: advClean.catMode === 'include' ? advClean.cats.join(',') : '',
    catOut: advClean.catMode === 'exclude' ? advClean.cats.join(',') : '',
    content: advClean.content,
    priceMin: advClean.priceMin,
    priceMax: advClean.priceMax,
  })

  const resetAll = () => {
    setCategory('全部类型')
    setDays(90)
    setSort('date-asc')
    setQ('')
    setQuery('')
    setAdv({ ...EMPTY_ADVANCED })
  }

  const hasAnyFilter =
    category !== '全部类型' || query !== '' || days !== 90 || sort !== 'date-asc' || advancedCount(advClean) > 0

  // 注意：isLoading 时不能提前 return（否则筛选栏/高级筛选弹层会被卸载重挂，输入焦点丢失）
  // —— 仅对汇总卡与列表区展示骨架屏/空态，筛选栏始终挂载

  return (
    <div className="space-y-4">
      {/* 筛选栏 */}
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <form
              className="relative flex-1 min-w-[180px]"
              onSubmit={(e) => {
                e.preventDefault()
                setQuery(q)
              }}
            >
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-stone-400" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onBlur={() => setQuery(q)}
                placeholder="搜索资费名称 / 编号…"
                className="pl-8 h-8 text-sm"
                data-testid="upcoming-search"
              />
            </form>

            <Select value={String(days)} onValueChange={(v) => setDays(parseInt(v, 10))}>
              <SelectTrigger className="w-[86px] h-8 text-xs" aria-label="时间范围">
                <CalendarClock className="size-3.5 text-stone-400" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_RANGES.map((r) => (
                  <SelectItem key={r.value} value={String(r.value)} className="text-xs">
                    未来 {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={sort} onValueChange={setSort}>
              <SelectTrigger className="w-[100px] h-8 text-xs" aria-label="排序">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value} className="text-xs">
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <AdvancedFilterPopover
              value={adv}
              onChange={setAdv}
              resultHint={data ? String(data.total) : null}
            />

            {hasAnyFilter && (
              <Button
                size="sm"
                variant="ghost"
                className="h-8 text-xs text-stone-500 hover:text-stone-700 px-2"
                onClick={resetAll}
                title="清空所有筛选条件"
              >
                <RotateCcw className="size-3" />
                重置
              </Button>
            )}
          </div>

          {/* 分类 chips */}
          <div className="flex flex-wrap items-center gap-1.5">
            {UPCOMING_CATEGORIES.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={`px-2.5 h-7 text-xs rounded-md border transition-colors ${
                  category === c
                    ? 'bg-rose-600 text-white border-rose-600'
                    : 'bg-white text-stone-600 border-stone-200 hover:border-rose-300 hover:text-rose-700'
                }`}
              >
                {c}
              </button>
            ))}
            <span className="text-[11px] text-stone-400 ml-1">
              {data?.total ?? 0} 个即将下线
            </span>
          </div>

          {/* 高级筛选生效 chips */}
          <AdvancedFilterChips value={advClean} onChange={setAdv} />
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-24 rounded-xl" />
          <Skeleton className="h-64 rounded-xl" />
        </div>
      ) : !data || data.items.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-stone-500">
            {hasAnyFilter ? (
              <>
                <PackageSearch className="mx-auto size-8 text-stone-300 mb-2" />
                没有符合条件的下线预告
              </>
            ) : (
              <>
                <Timer className="mx-auto size-8 text-stone-300 mb-2" />
                未来 {days} 天内没有资费下线
              </>
            )}
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 汇总卡片 + 紧急度分布 */}
          <Card className="border-rose-200 bg-gradient-to-r from-rose-50 to-orange-50 shadow-sm">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-4">
                <div className="size-11 rounded-xl bg-rose-100 border border-rose-200 flex items-center justify-center shrink-0">
                  <CalendarClock className="size-5 text-rose-600" />
                </div>
                <div className="flex-1">
                  <div className="text-sm font-semibold text-rose-800">
                    未来 {data.rangeDays} 天内将有 {data.total} 个资费下线
                  </div>
                  <div className="text-xs text-rose-700/70 mt-0.5">
                    按公示的下线日期倒计时，临近下线适合尽快办理或关注替代套餐
                  </div>
                </div>
              </div>

              {/* 紧急度分段条 */}
              <UrgencyBar items={data.items} total={data.total || 1} />
            </CardContent>
          </Card>

          <div className="flex items-center justify-between text-xs text-stone-500 px-1">
            <span>
              按 {SORTS.find((s) => s.value === sort)?.label}排序 · 点击卡片查看资费详情
            </span>
            <span>{Object.keys(data.byMonth).length} 个月份分组</span>
          </div>

          {Object.entries(data.byMonth)
            .sort(([a], [b]) => (sort === 'date-desc' ? b.localeCompare(a) : a.localeCompare(b)))
            .map(([month, items]) => (
              <Card key={month} className="border-stone-200 shadow-sm overflow-hidden">
                <div className="px-4 py-2.5 bg-stone-50 border-b border-stone-100 flex items-center justify-between">
                  <span className="text-sm font-semibold text-stone-700">
                    {month.replace('-', ' 年 ')} 月
                  </span>
                  <Badge variant="outline" className="bg-rose-50 text-rose-700 border-rose-200">
                    <TrendingDown className="size-3 mr-0.5" />
                    {items.length} 个下线
                  </Badge>
                </div>
                <CardContent className="p-2">
                  <div className="divide-y divide-stone-100">
                    {items.map((t) => (
                      <UpcomingRow key={t.code} tariff={t} rangeDays={data.rangeDays} onClick={() => onSelectTariff(t.code)} />
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
        </>
      )}
    </div>
  )
}

/** 紧急度分布条（7 天内 / 30 天内 / 观察中） */
function UrgencyBar({ items, total }: { items: TariffItem[]; total: number }) {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const urgency = { urgent: 0, soon: 0, watch: 0 }
  for (const t of items) {
    const d = new Date((t.offlineDate || '') + 'T00:00:00')
    const days = Math.ceil((d.getTime() - now.getTime()) / 86400000)
    if (days <= 7) urgency.urgent++
    else if (days <= 30) urgency.soon++
    else urgency.watch++
  }
  const pct = {
    urgent: (urgency.urgent / total) * 100,
    soon: (urgency.soon / total) * 100,
    watch: (urgency.watch / total) * 100,
  }
  return (
    <div>
      <div
        className="flex h-2.5 rounded-full overflow-hidden bg-stone-100"
        role="img"
        aria-label={`紧急 ${urgency.urgent}，关注 ${urgency.soon}，观察 ${urgency.watch}`}
      >
        <div className="bg-rose-500 transition-all" style={{ width: `${pct.urgent}%` }} />
        <div className="bg-amber-400 transition-all" style={{ width: `${pct.soon}%` }} />
        <div className="bg-stone-300 transition-all" style={{ width: `${pct.watch}%` }} />
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px]">
        <span className="inline-flex items-center gap-1 text-rose-700">
          <span className="size-2 rounded-full bg-rose-500" />
          <Flame className="size-3" />
          7 天内下线 <b>{urgency.urgent}</b> 个
        </span>
        <span className="inline-flex items-center gap-1 text-amber-700">
          <span className="size-2 rounded-full bg-amber-400" />
          <Eye className="size-3" />
          30 天内 <b>{urgency.soon}</b> 个
        </span>
        <span className="inline-flex items-center gap-1 text-stone-600">
          <span className="size-2 rounded-full bg-stone-300" />
          <Binoculars className="size-3" />
          观察中 <b>{urgency.watch}</b> 个
        </span>
      </div>
    </div>
  )
}

function UpcomingRow({
  tariff,
  rangeDays,
  onClick,
}: {
  tariff: TariffItem
  rangeDays: number
  onClick: () => void
}) {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const d = new Date((tariff.offlineDate || '') + 'T00:00:00')
  const days = Math.ceil((d.getTime() - now.getTime()) / 86400000)

  // 倒计时进度：剩余越少，进度越满（越接近下线）
  const progress = Math.max(0, Math.min(100, ((rangeDays - days) / rangeDays) * 100))

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-stone-50 transition-colors text-left group"
    >
      <div
        className={`size-12 shrink-0 rounded-lg border flex flex-col items-center justify-center ${
          days <= 7
            ? 'bg-rose-50 border-rose-200 text-rose-700'
            : days <= 30
              ? 'bg-amber-50 border-amber-200 text-amber-700'
              : 'bg-stone-50 border-stone-200 text-stone-600'
        }`}
      >
        <span className="text-base font-bold leading-none tabular-nums">{days}</span>
        <span className="text-[9px] mt-0.5">天后</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-stone-800 truncate group-hover:text-rose-800 transition-colors">
          {tariff.name}
        </div>
        <div className="flex items-center gap-2 mt-1 text-[11px] text-stone-400">
          <span className="font-mono">{tariff.code}</span>
          <Badge variant="outline" className={`text-[9px] h-4 px-1 ${CATEGORY_COLORS[tariff.category] ?? ''}`}>
            {tariff.category}
          </Badge>
        </div>
        {/* 倒计时进度条 */}
        <div className="mt-1.5 h-1 rounded-full bg-stone-100 overflow-hidden" title={`${rangeDays}天倒计时进度 ${progress.toFixed(0)}%`}>
          <div
            className={`h-full rounded-full transition-all ${
              days <= 7 ? 'bg-rose-500' : days <= 30 ? 'bg-amber-400' : 'bg-stone-300'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-sm font-semibold text-stone-700">{tariff.price || '—'}</div>
        <div className="text-[11px] text-stone-400">{formatDateCN(tariff.offlineDate).slice(5)}</div>
      </div>
    </button>
  )
}
