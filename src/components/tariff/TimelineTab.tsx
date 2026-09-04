'use client'

import { useState, useMemo, useSyncExternalStore } from 'react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { ChevronLeft, ChevronRight, Search, CalendarDays, ArrowUpRight, ArrowDownRight, RefreshCw, X, Rss, Copy, Check, Crosshair, Download, ChevronUp, ChevronDown } from 'lucide-react'
import { useTimeline, useHeatmap, useStats, type AdvancedFilters, EMPTY_ADVANCED } from './api'
import { AdvancedFilterPopover, AdvancedFilterChips, sanitizeAdvanced } from './AdvancedFilter'
import { toast } from 'sonner'
import { formatMonthCN, shiftMonth } from '@/lib/month-range'
import { subscribeUrl, updateUrlParam, getMonthFromUrl, getYearFromUrl, getDateFromUrl, getServerParamSnapshot } from '@/lib/url-store'
import {
  TYPE_META,
  CATEGORY_COLORS,
  SOURCE_LABELS,
  formatDateCN,
  type ChangeEventItem,
} from './types'

const DAY_RANGES = [
  { value: '7', label: '近7天' },
  { value: '30', label: '近30天' },
  { value: '90', label: '近90天' },
  { value: 'all', label: '全部' },
]

const HEAT_RANGES = [
  { value: 90, label: '3个月' },
  { value: 180, label: '半年' },
  { value: 365, label: '一年' },
]

const CATEGORIES = ['套餐', '加装包', '营销活动', '港澳台/国际资费']
const TYPES = [
  { value: 'ADDED', label: '上线' },
  { value: 'REMOVED', label: '下线' },
  { value: 'UPDATED', label: '变更' },
]

const MONTH_PARAM = 'month'
const YEAR_PARAM = 'year'
const DATE_PARAM = 'date'

/** 清除 URL 中的月份下钻参数（并通知所有订阅者） */
function clearMonthParam() {
  updateUrlParam(MONTH_PARAM, null)
}

/** 清除 URL 中的年度下钻参数（并通知所有订阅者） */
function clearYearParam() {
  updateUrlParam(YEAR_PARAM, null)
}

/** 清除 URL 中的日期下钻参数（并通知所有订阅者） */
function clearDateParam() {
  updateUrlParam(DATE_PARAM, null)
}

export function TimelineTab({
  onSelectTariff,
  initialQuery = '',
  onClearInitialQuery,
}: {
  onSelectTariff: (code: string) => void
  /** 深链接预填搜索词（URL ?q=，从详情弹窗"仅看此资费"跳入） */
  initialQuery?: string
  /** 用户清除过滤 badge 时同步清 URL ?q= */
  onClearInitialQuery?: () => void
}) {
  /** 资费编号式深链接（8 位以上大写字母数字），跳入时自动看全量时间范围 */
  const isCodeDeepLink = /^[A-Z0-9]{8,}$/.test(initialQuery)

  /** 月份下钻：URL ?month= 作为唯一状态源（洞察图点击写入；本组件内部可清除）
   *  用 useSyncExternalStore 直接订阅地址栏，避免组件内 state 与 URL 双源不同步 */
  const monthParam = useSyncExternalStore(subscribeUrl, getMonthFromUrl, getServerParamSnapshot)
  const isMonthParam = /^\d{4}-\d{2}$/.test(monthParam)

  /** 年度下钻：URL ?year= 作为唯一状态源（洞察年度图点击写入；本组件内部可清除）
   *  与月份/日期互斥且优先级最低——date > month > year，与 API 优先级一致 */
  const yearParam = useSyncExternalStore(subscribeUrl, getYearFromUrl, getServerParamSnapshot)

  /** 日期下钻：URL ?date= 作为唯一状态源（热力图点选 / 页头更新记录下钻写入）
   *  优先级最高：date 激活时 month/year 一律忽略（与 /api/timeline 参数优先级一致） */
  const dateParam = useSyncExternalStore(subscribeUrl, getDateFromUrl, getServerParamSnapshot)
  const isDateDeepLink = /^\d{4}-\d{2}-\d{2}$/.test(dateParam)

  /** 互斥链 date > month > year：上级激活时下级一律置空 */
  const monthFilter = isDateDeepLink ? '' : monthParam
  const isMonthDeepLink = isMonthParam && monthFilter === monthParam
  const yearFilter = isDateDeepLink || isMonthDeepLink ? '' : yearParam
  const isYearDeepLink = /^\d{4}$/.test(yearFilter)
  const dateFilter = isDateDeepLink ? dateParam : ''

  const [days, setDays] = useState('30')
  const [category, setCategory] = useState('')
  const [type, setType] = useState('')
  const [source, setSource] = useState('')
  const [q, setQ] = useState(initialQuery)
  const [query, setQuery] = useState(initialQuery)
  const [page, setPage] = useState(1)
  const [heatRange, setHeatRange] = useState(180)
  // 高级筛选（类型多选包含/排除、套餐内容、价格区间）
  const [adv, setAdv] = useState<AdvancedFilters>({ ...EMPTY_ADVANCED })
  const advClean = sanitizeAdvanced(adv)

  /** 是否为资费编号式过滤（区分"仅看此资费"和普通关键词搜索） */
  const isCodeFilter = /^[A-Z0-9]{8,}$/.test(query)

  /** 生效时间范围：月/年/日期/编号深链接激活时强制「全部」
   *  （这些模式下 days 参数被 API 忽略——优先级 date > month > year > days，
   *  但 UI 高亮必须如实反映当前查询口径；纯派生不清源 state，清除深链接后自然回到用户先前选的范围） */
  const effectiveDays =
    isDateDeepLink || isMonthDeepLink || isYearDeepLink || isCodeDeepLink ? 'all' : days

  const { data, isLoading, isFetching } = useTimeline({
    days: effectiveDays,
    category,
    type,
    source,
    q: query,
    date: dateFilter,
    month: monthFilter,
    year: yearFilter,
    catIn: advClean.catMode === 'include' ? advClean.cats.join(',') : '',
    catOut: advClean.catMode === 'exclude' ? advClean.cats.join(',') : '',
    content: advClean.content,
    priceMin: advClean.priceMin,
    priceMax: advClean.priceMax,
    page,
  })
  const { data: heatmap } = useHeatmap(heatRange)
  // 最早事件日期（翻月下界；stats 已缓存 60s，代价可忽略）
  const { data: stats } = useStats()

  const totalPages = data?.totalPages ?? 1

  /** 月份翻页：上界=当前月（未来无数据），下界=最早事件月 */
  const currentMonth = new Date().toISOString().slice(0, 7)
  const minMonth = stats?.earliestEventDate ? stats.earliestEventDate.slice(0, 7) : ''
  const prevMonth = isMonthDeepLink ? shiftMonth(monthFilter, -1) : ''
  const nextMonth = isMonthDeepLink ? shiftMonth(monthFilter, 1) : ''
  const canPrev = isMonthDeepLink && prevMonth >= (minMonth || '0000-00')
  const canNext = isMonthDeepLink && nextMonth <= currentMonth

  /** 翻月：直写 URL（不重挂，页码归一需重置分页 state） */
  const goMonth = (m: string) => {
    updateUrlParam(MONTH_PARAM, m)
    setPage(1)
  }

  /** 年度翻页：上界=当前年（未来无数据），下界=最早事件年 */
  const currentYear = new Date().getFullYear()
  const minYear = stats?.earliestEventDate ? Number(stats.earliestEventDate.slice(0, 4)) : 0
  const prevYear = isYearDeepLink ? String(Number(yearFilter) - 1) : ''
  const nextYear = isYearDeepLink ? String(Number(yearFilter) + 1) : ''
  const canPrevYear = isYearDeepLink && Number(prevYear) >= minYear
  const canNextYear = isYearDeepLink && Number(nextYear) <= currentYear

  /** 翻年：直写 URL（不重挂，页码重置） */
  const goYear = (y: string) => {
    updateUrlParam(YEAR_PARAM, y)
    setPage(1)
  }

  /** 月份/年度/日期互斥：选日期时清月份与年份（写 URL，不触发重挂——key 不含 month/year/date） */
  const applyDateFilter = (d: string) => {
    if (d) {
      updateUrlParam(DATE_PARAM, d)
      clearMonthParam()
      clearYearParam()
      setPage(1)
    }
  }

  return (
    <div className="space-y-4">
      {/* 热力图导航条 */}
      <HeatmapStrip
        items={heatmap?.items ?? []}
        range={heatRange}
        onRangeChange={(r) => setHeatRange(r)}
        selected={dateFilter}
        onSelect={(d) => {
          // 日期与月份/年度互斥：点热力图日期时清月/年（URL 直写，不重挂）；再点同一天取消
          if (dateFilter === d) {
            clearDateParam()
          } else {
            applyDateFilter(d)
          }
          setPage(1)
        }}
      />

      {/* 筛选栏 */}
      <Card className="border-stone-200 shadow-sm">
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Tabs value={effectiveDays} onValueChange={(v) => { setDays(v); clearDateParam(); clearMonthParam(); clearYearParam(); setPage(1) }}>
              <TabsList className="h-8">
                {DAY_RANGES.map((r) => (
                  <TabsTrigger key={r.value} value={r.value} className="text-xs h-7 px-3">
                    {r.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>

            <div className="flex items-center gap-1.5 flex-wrap">
              {TYPES.map((t) => (
                <button
                  key={t.value}
                  onClick={() => { setType(type === t.value ? '' : t.value); setPage(1) }}
                  className={`px-2.5 h-7 text-xs rounded-md border transition-colors ${
                    type === t.value
                      ? t.value === 'ADDED'
                        ? 'bg-emerald-600 text-white border-emerald-600'
                        : t.value === 'REMOVED'
                          ? 'bg-rose-600 text-white border-rose-600'
                          : 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex-1" />

            <div className="flex items-center gap-1.5 flex-wrap">
              {(['', ...CATEGORIES] as const).map((c) => (
                <button
                  key={c || 'all'}
                  onClick={() => { setCategory(c); setPage(1) }}
                  className={`px-2.5 h-7 text-xs rounded-md border transition-colors ${
                    category === c
                      ? 'bg-stone-800 text-white border-stone-800'
                      : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300'
                  }`}
                >
                  {c || '全部类型'}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <form
              className="flex-1 min-w-[180px] relative"
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
                placeholder="搜索资费名称 / 方案编号…"
                className="pl-8 h-8 text-sm"
              />
            </form>
            <Select value={source} onValueChange={(v) => { setSource(v === 'all' ? '' : v); setPage(1) }}>
              <SelectTrigger className="w-[130px] h-8 text-xs">
                <SelectValue placeholder="全部来源" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">全部来源</SelectItem>
                {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k} className="text-xs">{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isFetching && <RefreshCw className="size-3.5 text-stone-400 animate-spin" />}
            <AdvancedFilterPopover
              value={adv}
              onChange={setAdv}
              resultHint={data ? String(data.totalDays) : null}
            />
            <ExportEventsButton
              days={effectiveDays}
              category={category}
              type={type}
              source={source}
              q={query}
              date={dateFilter}
              month={monthFilter}
              year={yearFilter}
              catIn={advClean.catMode === 'include' ? advClean.cats.join(',') : ''}
              catOut={advClean.catMode === 'exclude' ? advClean.cats.join(',') : ''}
              content={advClean.content}
              priceMin={advClean.priceMin}
              priceMax={advClean.priceMax}
              totalDays={data?.totalDays ?? 0}
            />
            <FeedButton />
            <span className="text-xs text-stone-500">
              共 {data?.totalDays ?? 0} 个变更日
            </span>
          </div>

          {isMonthDeepLink && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Badge className="bg-violet-100 text-violet-800 border border-violet-200 hover:bg-violet-100 gap-1">
                <CalendarDays className="size-3" />
                已选月份：{formatMonthCN(monthFilter)}
                <button
                  onClick={() => { clearMonthParam(); setPage(1) }}
                  title="清除月份过滤"
                >
                  <X className="size-3" />
                </button>
              </Badge>
              {/* 月份翻页：上一月/下一月（上界=当前月，下界=最早事件月） */}
              <div className="flex items-center rounded-md border border-violet-200 overflow-hidden bg-white">
                <button
                  onClick={() => canPrev && goMonth(prevMonth)}
                  disabled={!canPrev}
                  title={canPrev ? `上一月（${formatMonthCN(prevMonth)}）` : '已到最早数据月份'}
                  className="px-2 h-7 flex items-center gap-0.5 text-[11px] text-violet-700 hover:bg-violet-50 transition-colors disabled:text-stone-300 disabled:bg-stone-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="size-3" />
                  {canPrev ? formatMonthCN(prevMonth) : '上一月'}
                </button>
                <div className="w-px h-5 bg-violet-200" aria-hidden="true" />
                <button
                  onClick={() => canNext && goMonth(nextMonth)}
                  disabled={!canNext}
                  title={canNext ? `下一月（${formatMonthCN(nextMonth)}）` : '已到当前月份'}
                  className="px-2 h-7 flex items-center gap-0.5 text-[11px] text-violet-700 hover:bg-violet-50 transition-colors disabled:text-stone-300 disabled:bg-stone-50 disabled:cursor-not-allowed"
                >
                  {canNext ? formatMonthCN(nextMonth) : '下一月'}
                  <ChevronRight className="size-3" />
                </button>
              </div>
              <span className="text-[11px] text-stone-400">从洞察页图表下钻 · 展示该月全部变更 · 可翻月</span>
            </div>
          )}

          {isYearDeepLink && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Badge className="bg-amber-100 text-amber-800 border border-amber-200 hover:bg-amber-100 gap-1">
                <CalendarDays className="size-3" />
                已选年份：{yearFilter} 年
                <button
                  onClick={() => { clearYearParam(); setPage(1) }}
                  title="清除年份过滤"
                >
                  <X className="size-3" />
                </button>
              </Badge>
              {/* 年度翻页：上一年/下一年（上界=当前年，下界=最早事件年） */}
              <div className="flex items-center rounded-md border border-amber-200 overflow-hidden bg-white">
                <button
                  onClick={() => canPrevYear && goYear(prevYear)}
                  disabled={!canPrevYear}
                  title={canPrevYear ? `上一年（${prevYear} 年）` : '已到最早数据年份'}
                  className="px-2 h-7 flex items-center gap-0.5 text-[11px] text-amber-700 hover:bg-amber-50 transition-colors disabled:text-stone-300 disabled:bg-stone-50 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="size-3" />
                  {canPrevYear ? `${prevYear} 年` : '上一年'}
                </button>
                <div className="w-px h-5 bg-amber-200" aria-hidden="true" />
                <button
                  onClick={() => canNextYear && goYear(nextYear)}
                  disabled={!canNextYear}
                  title={canNextYear ? `下一年（${nextYear} 年）` : '已到当前年份'}
                  className="px-2 h-7 flex items-center gap-0.5 text-[11px] text-amber-700 hover:bg-amber-50 transition-colors disabled:text-stone-300 disabled:bg-stone-50 disabled:cursor-not-allowed"
                >
                  {canNextYear ? `${nextYear} 年` : '下一年'}
                  <ChevronRight className="size-3" />
                </button>
              </div>
              <span className="text-[11px] text-stone-400">从洞察页年度图下钻 · 展示该年全部变更 · 可翻年</span>
            </div>
          )}

          {dateFilter && (
            <div className="flex items-center gap-2 pt-1">
              <Badge className="bg-emerald-100 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 gap-1">
                <CalendarDays className="size-3" />
                已选日期：{formatDateCN(dateFilter)}
                <button onClick={() => { clearDateParam(); setPage(1) }} title="清除日期过滤">
                  <X className="size-3" />
                </button>
              </Badge>
              <span className="text-[11px] text-stone-400">点击热力图同一天可取消 · 链接可分享</span>
            </div>
          )}

          {query && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {isCodeFilter ? (
                <Badge className="bg-teal-100 text-teal-800 border border-teal-200 hover:bg-teal-100 gap-1">
                  <Crosshair className="size-3" />
                  仅看此资费
                  <code className="font-mono text-[10px]">{query}</code>
                  <button
                    onClick={() => { setQ(''); setQuery(''); onClearInitialQuery?.(); setPage(1) }}
                    title="取消资费过滤"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              ) : (
                <Badge className="bg-stone-100 text-stone-700 border border-stone-200 hover:bg-stone-100 gap-1">
                  <Search className="size-3" />
                  搜索：{query}
                  <button
                    onClick={() => { setQ(''); setQuery(''); onClearInitialQuery?.(); setPage(1) }}
                    title="清除搜索词"
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              )}
              {isCodeFilter && (
                <span className="text-[11px] text-stone-400">仅展示该资费的全部上下线/变更轨迹</span>
              )}
            </div>
          )}

          {/* 高级筛选生效 chips */}
          <AdvancedFilterChips value={advClean} onChange={setAdv} />
        </CardContent>
      </Card>

      {/* 时间轴 */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-40 w-full rounded-xl" />
          ))}
        </div>
      ) : !data || data.days.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-stone-500">
            <CalendarDays className="mx-auto size-8 text-stone-300 mb-2" />
            该筛选条件下没有变更记录
          </CardContent>
        </Card>
      ) : (
        <div className="relative">
          {/* 时间轴竖线 */}
          <div className="absolute left-[19px] sm:left-[27px] top-2 bottom-2 w-px bg-gradient-to-b from-emerald-200 via-stone-200 to-rose-200" />
          <div className="space-y-6">
            {data.days.map((day) => (
              <TimelineDayCard
                key={day.date}
                day={day}
                onSelectTariff={onSelectTariff}
              />
            ))}
          </div>
        </div>
      )}

      {/* 分页 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3 py-2">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft className="size-4" /> 上一页
          </Button>
          <span className="text-xs text-stone-500">
            {page} / {totalPages} 页
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            下一页 <ChevronRight className="size-4" />
          </Button>
        </div>
      )}
    </div>
  )
}

/** 热力图导航条（GitHub 贡献图风格，支持时间范围切换） */
function HeatmapStrip({
  items,
  range,
  onRangeChange,
  selected,
  onSelect,
}: {
  items: { date: string; total: number; added: number; removed: number; updated: number }[]
  range: number
  onRangeChange: (r: number) => void
  selected: string
  onSelect: (date: string) => void
}) {
  const max = useMemo(
    () => items.reduce((m, i) => Math.max(m, i.total), 1),
    [items]
  )

  // 填充成按周列布局（列=周，行=周一~周日），周数由范围决定
  const cells = useMemo(() => {
    const byDate = new Map(items.map((i) => [i.date, i]))
    // 从今天往前推 N 周
    const weeks = Math.ceil(range / 7)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const start = new Date(today)
    start.setDate(start.getDate() - (weeks * 7 - 1))
    // 对齐到周一
    const dow = (start.getDay() + 6) % 7
    start.setDate(start.getDate() - dow)
    const cols: { date: string; item?: { total: number; added: number; removed: number; updated: number } }[][] = []
    const cur = new Date(start)
    while (cur <= today) {
      const week: { date: string; item?: { total: number; added: number; removed: number; updated: number } }[] = []
      for (let d = 0; d < 7; d++) {
        const ds = cur.toISOString().slice(0, 10)
        week.push({ date: ds, item: byDate.get(ds) })
        cur.setDate(cur.getDate() + 1)
      }
      cols.push(week)
    }
    return cols
  }, [items, range])

  const intensity = (n: number) => {
    if (n === 0) return 'bg-stone-100'
    const ratio = n / max
    if (ratio > 0.5) return 'bg-emerald-600'
    if (ratio > 0.2) return 'bg-emerald-500'
    if (ratio > 0.05) return 'bg-emerald-300'
    return 'bg-emerald-200'
  }

  const months = useMemo(() => {
    const marks: { col: number; label: string }[] = []
    let lastMonth = ''
    cells.forEach((week, ci) => {
      const m = week[0]?.date.slice(0, 7) || ''
      if (m && m !== lastMonth) {
        lastMonth = m
        marks.push({ col: ci, label: `${parseInt(m.slice(5))}月` })
      }
    })
    return marks
  }, [cells])

  if (items.length === 0) return null

  return (
    <Card className="border-stone-200 shadow-sm">
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2.5">
            <span className="text-xs font-semibold text-stone-700 flex items-center gap-1.5">
              <CalendarDays className="size-3.5 text-emerald-600" />
              资费变更热力图
            </span>
            <div className="flex items-center rounded-md border border-stone-200 bg-stone-50 p-0.5">
              {HEAT_RANGES.map((r) => (
                <button
                  key={r.value}
                  onClick={() => onRangeChange(r.value)}
                  className={`px-1.5 h-5 text-[10px] rounded transition-colors ${
                    range === r.value
                      ? 'bg-white text-emerald-700 font-medium shadow-sm'
                      : 'text-stone-500 hover:text-stone-700'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-stone-400">
            <span>少</span>
            <span className="size-2.5 rounded-sm bg-stone-100 border border-stone-200" />
            <span className="size-2.5 rounded-sm bg-emerald-200" />
            <span className="size-2.5 rounded-sm bg-emerald-300" />
            <span className="size-2.5 rounded-sm bg-emerald-500" />
            <span className="size-2.5 rounded-sm bg-emerald-600" />
            <span>多</span>
          </div>
        </div>
        <TooltipProvider delayDuration={80}>
          <div className="overflow-x-auto pb-1">
            <div className="min-w-max">
              {/* 月份标尺 */}
              <div className="relative h-4 mb-0.5 ml-6">
                {months.map((m) => (
                  <span
                    key={m.col + m.label}
                    className="absolute text-[9px] text-stone-400"
                    style={{ left: `${m.col * 14}px` }}
                  >
                    {m.label}
                  </span>
                ))}
              </div>
              <div className="flex gap-[3px] ml-6">
                {cells.map((week, ci) => (
                  <div key={ci} className="flex flex-col gap-[3px]">
                    {week.map((day) => {
                      const it = day.item
                      const isSel = selected === day.date
                      const isFuture = day.date > new Date().toISOString().slice(0, 10)
                      return (
                        <Tooltip key={day.date}>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => it && onSelect(day.date)}
                              disabled={!it}
                              className={`size-2.5 rounded-[3px] transition-all ${
                                isSel
                                  ? 'ring-2 ring-offset-1 ring-emerald-600 scale-125'
                                  : it
                                    ? `${intensity(it.total)} hover:scale-125 hover:ring-1 hover:ring-emerald-400 cursor-pointer`
                                    : isFuture
                                      ? 'bg-transparent'
                                      : 'bg-stone-100'
                              } ${it ? '' : 'cursor-default'}`}
                              aria-label={`${day.date}${it ? `：${it.total} 个事件` : ' 无事件'}`}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-xs">
                            <div className="font-semibold">{formatDateCN(day.date)}</div>
                            {it ? (
                              <div className="mt-0.5 space-y-0.5 text-[11px]">
                                <div>共 {it.total} 个事件</div>
                                {it.added > 0 && <div className="text-emerald-600">上线 {it.added}</div>}
                                {it.removed > 0 && <div className="text-rose-600">下线 {it.removed}</div>}
                                {it.updated > 0 && <div className="text-amber-600">变更 {it.updated}</div>}
                              </div>
                            ) : (
                              <div className="text-[11px] text-stone-400">无变更</div>
                            )}
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </TooltipProvider>
        <div className="mt-2 text-[10px] text-stone-400 flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-[3px] bg-emerald-600" />
          颜色越深 = 当日变更越多；点击格子可按日期过滤时间轴
        </div>
      </CardContent>
    </Card>
  )
}

function TimelineDayCard({
  day,
  onSelectTariff,
}: {
  day: {
    date: string
    total: number
    byType: Record<string, number>
    events: ChangeEventItem[]
  }
  onSelectTariff: (code: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [exporting, setExporting] = useState(false)
  const d = new Date(day.date + 'T00:00:00')
  const isToday = day.date === new Date().toISOString().slice(0, 10)
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]

  const shown = expanded ? day.events : day.events.slice(0, 6)
  const added = day.byType['ADDED'] || 0
  const removed = day.byType['REMOVED'] || 0
  const updated = day.byType['UPDATED'] || 0

  /** 导出当日全部事件 CSV（含未在页面展示的部分） */
  const exportDay = async () => {
    setExporting(true)
    try {
      const res = await fetch(`/api/export?kind=events&date=${day.date}`)
      if (!res.ok) throw new Error(`导出失败（${res.status}）`)
      const blob = await res.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `tariff-events-${day.date}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(link.href)
      toast.success(`已导出 ${day.date} 当日 ${day.total} 个事件 CSV`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div className="relative pl-12 sm:pl-20">
      {/* 时间轴节点 */}
      <div
        className={`absolute left-0 top-1 size-10 sm:size-14 rounded-xl border-2 flex flex-col items-center justify-center z-10 shadow-sm transition-transform duration-200 hover:scale-110 ${
          isToday
            ? 'bg-emerald-600 border-emerald-700 text-white'
            : 'bg-white border-stone-300 text-stone-700 hover:border-emerald-400'
        }`}
      >
        <span className="text-sm sm:text-lg font-bold leading-none">
          {d.getDate()}
        </span>
        <span className="text-[9px] sm:text-[10px] leading-none mt-0.5 opacity-80">
          {d.getMonth() + 1}月
        </span>
      </div>

      <div
        className={`rounded-xl border shadow-sm bg-white overflow-hidden transition-colors duration-200 ${
          isToday
            ? 'border-emerald-300 ring-1 ring-emerald-200'
            : 'border-stone-200 hover:border-stone-300'
        }`}
      >
        {/* 日期头：主体可点击展开/收起，右侧导出当日事件 */}
        <div className="flex items-stretch">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="flex-1 min-w-0 flex flex-wrap items-center gap-2 px-4 py-3 text-left hover:bg-stone-50/60 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span className={`font-semibold ${isToday ? 'text-emerald-800' : 'text-stone-800'}`}>
                {formatDateCN(day.date)}
              </span>
              <span className="text-xs text-stone-400">周{weekday}</span>
              {isToday && (
                <Badge className="bg-emerald-100 text-emerald-700 border border-emerald-200 hover:bg-emerald-100 text-[10px] h-4.5">
                  今天
                </Badge>
              )}
            </div>
            <div className="flex-1" />
            <div className="flex items-center gap-2 text-xs">
              {day.total > day.events.length && (
                <span className="text-stone-500">共 {day.total} 个</span>
              )}
              {added > 0 && (
                <span className="inline-flex items-center gap-0.5 text-emerald-700 font-medium">
                  <ArrowUpRight className="size-3.5" /> 上线 {added}
                </span>
              )}
              {removed > 0 && (
                <span className="inline-flex items-center gap-0.5 text-rose-700 font-medium">
                  <ArrowDownRight className="size-3.5" /> 下线 {removed}
                </span>
              )}
              {updated > 0 && (
                <span className="inline-flex items-center gap-0.5 text-amber-700 font-medium">
                  <RefreshCw className="size-3" /> 变更 {updated}
                </span>
              )}
            </div>
          </button>
          <button
            onClick={exportDay}
            disabled={exporting}
            title={`导出 ${day.date} 当日全部事件 CSV（含未展示部分）`}
            aria-label={`导出 ${day.date} 当日事件`}
            className="shrink-0 self-center inline-flex items-center justify-center size-8 mr-2 rounded-md border border-transparent text-stone-400
              hover:text-teal-700 hover:bg-teal-50 hover:border-teal-200 transition-colors disabled:opacity-50"
          >
            {exporting ? <RefreshCw className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
          </button>
        </div>

        {/* 事件列表 */}
        <div className="px-4 pb-3 space-y-2">
          {shown.map((e) => (
            <EventRow key={e.id} event={e} onSelectTariff={onSelectTariff} />
          ))}
          {day.total > day.events.length && (
            <div className="text-center text-[11px] text-stone-400 py-1 border-t border-dashed border-stone-200">
              当日共 {day.total} 个事件，为避免卡顿仅展示前 {day.events.length} 条 ·
              可用上方类型/搜索筛选缩小范围
            </div>
          )}
          {!expanded && day.events.length > 6 && (
            <button
              onClick={() => setExpanded(true)}
              className="w-full text-center text-xs text-stone-500 hover:text-stone-700 py-1.5 border-t border-dashed border-stone-200"
            >
              展开其余 {day.events.length - 6} 条…
            </button>
          )}
          {expanded && day.events.length > 6 && (
            <button
              onClick={() => setExpanded(false)}
              className="w-full text-center text-xs text-stone-500 hover:text-stone-700 py-1.5 border-t border-dashed border-stone-200"
            >
              收起
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function EventRow({
  event,
  onSelectTariff,
}: {
  event: ChangeEventItem
  onSelectTariff: (code: string) => void
}) {
  const meta = TYPE_META[event.type] ?? TYPE_META.UPDATED
  let changes: { field: string; before: string | null; after: string | null }[] = []
  try {
    changes = event.changedFields ? JSON.parse(event.changedFields) : []
  } catch {
    /* ignore */
  }

  return (
    <div
      className={`rounded-lg border p-2.5 transition-colors ${
        event.tariffCode ? 'cursor-pointer hover:shadow-sm' : ''
      } ${meta.bg}`}
      onClick={() => event.tariffCode && onSelectTariff(event.tariffCode)}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-xs font-bold ${meta.color} shrink-0`}>
          {meta.icon} {meta.label}
        </span>
        <span className="text-sm font-medium text-stone-800 truncate">
          {event.tariffName}
        </span>
        {event.category && (
          <Badge
            variant="outline"
            className={`text-[10px] h-4.5 px-1.5 ${CATEGORY_COLORS[event.category] ?? CATEGORY_COLORS['其他']}`}
          >
            {event.category}
          </Badge>
        )}
        {event.source === 'sync' && (
          <Badge variant="outline" className="text-[10px] h-4.5 px-1.5 bg-teal-50 text-teal-700 border-teal-200">
            同步
          </Badge>
        )}
      </div>
      {changes.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs">
          {changes.slice(0, 3).map((c, i) => (
            <span key={i} className="text-stone-600">
              <span className="text-stone-400">{c.field}：</span>
              <span className="line-through text-rose-500/80">{c.before}</span>
              <span className="mx-1 text-stone-400">→</span>
              <span className="font-medium text-emerald-700">{c.after}</span>
            </span>
          ))}
          {changes.length > 3 && (
            <span className="text-stone-400">+{changes.length - 3} 项</span>
          )}
        </div>
      )}
    </div>
  )
}

/** 订阅入口：RSS / JSON 订阅源弹层（支持类型/分类/回看天数定制链接）
 *  桌面：Popover 锚点弹层；移动端：底部 Sheet 抽屉（拇指可达 + 内容全展开） */
function FeedButton() {
  const isMobile = useIsMobile()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [feedType, setFeedType] = useState<'' | 'ADDED' | 'REMOVED' | 'UPDATED'>('')
  const [feedCategory, setFeedCategory] = useState('')
  const [feedDays, setFeedDays] = useState('30')

  const buildUrl = (format: 'rss' | 'json') => {
    return `${window.location.origin}${buildPath(format)}`
  }

  /** 展示用相对路径（SSR 安全，不访问 window） */
  const buildPath = (format: 'rss' | 'json') => {
    const sp = new URLSearchParams()
    if (format === 'json') sp.set('format', 'json')
    if (feedType) sp.set('type', feedType)
    if (feedCategory) sp.set('category', feedCategory)
    if (feedDays !== '30') sp.set('days', feedDays)
    const qs = sp.toString()
    return `/api/feed${qs ? '?' + qs : ''}`
  }

  const copyLink = async (kind: 'rss' | 'json') => {
    const url = buildUrl(kind)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(kind)
      setTimeout(() => setCopied(null), 2000)
    } catch {
      window.open(url, '_blank')
    }
  }

  const feedTypeChips: { value: '' | 'ADDED' | 'REMOVED' | 'UPDATED'; label: string; active: string }[] = [
    { value: '', label: '全部', active: 'bg-stone-700 text-white border-stone-700' },
    { value: 'ADDED', label: '仅上线', active: 'bg-emerald-600 text-white border-emerald-600' },
    { value: 'REMOVED', label: '仅下线', active: 'bg-rose-600 text-white border-rose-600' },
    { value: 'UPDATED', label: '仅变更', active: 'bg-amber-500 text-white border-amber-500' },
  ]

  /** 弹层/抽屉共用的正文 JSX（状态共享；标题/描述由两种形态各自语义化渲染：
      移动端 SheetTitle/SheetDescription 满足 Radix a11y 要求，桌面端保持普通标签） */
  const panel = (
    <>
        {/* 类型过滤 */}
        <div className="mb-2.5">
          <div className="text-[10px] font-medium text-stone-500 mb-1.5">订阅内容</div>
          <div className="flex flex-wrap gap-1.5">
            {feedTypeChips.map((c) => (
              <button
                key={c.value || 'all'}
                onClick={() => setFeedType(c.value)}
                className={`px-2 h-6 text-[11px] rounded-md border transition-colors ${
                  feedType === c.value
                    ? c.active
                    : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>

        {/* 分类过滤 */}
        <div className="mb-2.5">
          <div className="text-[10px] font-medium text-stone-500 mb-1.5">资费分类</div>
          <div className="flex flex-wrap gap-1.5">
            {['', ...CATEGORIES].map((c) => (
              <button
                key={c || 'cat-all'}
                onClick={() => setFeedCategory(c)}
                className={`px-2 h-6 text-[11px] rounded-md border transition-colors ${
                  feedCategory === c
                    ? 'bg-teal-600 text-white border-teal-600'
                    : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300'
                }`}
              >
                {c ? (c === '港澳台/国际资费' ? '港澳台/国际' : c) : '全部分类'}
              </button>
            ))}
          </div>
        </div>

        {/* 回看天数 */}
        <div className="mb-3">
          <div className="text-[10px] font-medium text-stone-500 mb-1.5">回看范围</div>
          <div className="flex gap-1.5">
            {['7', '30', '90'].map((d) => (
              <button
                key={d}
                onClick={() => setFeedDays(d)}
                className={`px-2 h-6 text-[11px] rounded-md border transition-colors ${
                  feedDays === d
                    ? 'bg-orange-600 text-white border-orange-600'
                    : 'bg-white text-stone-600 border-stone-200 hover:border-stone-300'
                }`}
              >
                近 {d} 天
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <button
            onClick={() => copyLink('rss')}
            className="w-full flex items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-xs hover:border-orange-300 hover:bg-orange-50 transition-colors group"
          >
            <span className="flex items-center gap-2 text-stone-700">
              <Rss className="size-4 text-orange-600" />
              <span className="font-medium">RSS 2.0 源</span>
              <code className="text-[10px] text-stone-400 truncate max-w-[120px]">{buildPath('rss')}</code>
            </span>
            {copied === 'rss' ? (
              <Check className="size-3.5 text-emerald-600" />
            ) : (
              <Copy className="size-3.5 text-stone-400 group-hover:text-stone-600" />
            )}
          </button>
          <button
            onClick={() => copyLink('json')}
            className="w-full flex items-center justify-between rounded-md border border-stone-200 px-3 py-2 text-xs hover:border-teal-300 hover:bg-teal-50 transition-colors group"
          >
            <span className="flex items-center gap-2 text-stone-700">
              <svg viewBox="0 0 24 24" className="size-4 text-teal-600" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="m8 6-6 6 6 6M16 6l6 6-6 6" />
              </svg>
              <span className="font-medium">JSON 接口</span>
              <code className="text-[10px] text-stone-400 truncate max-w-[120px]">{buildPath('json')}</code>
            </span>
            {copied === 'json' ? (
              <Check className="size-3.5 text-emerald-600" />
            ) : (
              <Copy className="size-3.5 text-stone-400 group-hover:text-stone-600" />
            )}
          </button>
        </div>

        <button
          onClick={() => window.open(buildUrl('rss'), '_blank')}
          className="mt-2 w-full text-center text-[11px] text-stone-400 hover:text-orange-600 transition-colors"
        >
          在新窗口预览当前订阅源 →
        </button>

        <div className="mt-2 pt-2 border-t border-stone-100 text-[10px] text-stone-400 leading-relaxed">
          订阅源每日更新 · ttl 720 分钟 · 也可手动加 limit=N 控制条数
        </div>
    </>
  )

  /** 触发按钮（两种形态共用，受控 open） */
  const trigger = (
    <button
      onClick={() => setOpen(true)}
      className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-orange-300 bg-orange-50 text-orange-700 text-xs font-medium hover:bg-orange-100 active:scale-[0.98] transition-all"
      title="订阅资费变更"
    >
      <Rss className="size-3.5" />
      订阅
    </button>
  )

  if (isMobile) {
    // 移动端：底部抽屉（thumb-friendly，内容完整可达，无溢出裁剪问题）
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        {trigger}
        <SheetContent
          side="bottom"
          className="gap-0 px-4 pt-2 pb-[max(1.25rem,env(safe-area-inset-bottom))] max-h-[85vh] overflow-y-auto overscroll-contain rounded-t-xl"
        >
          {/* 抽屉顶部拖拽把手（视觉提示可下滑关闭） */}
          <div className="mx-auto h-1.5 w-10 rounded-full bg-stone-200 mb-2 shrink-0" aria-hidden="true" />
          {/* 语义化标题（Radix Dialog a11y：SheetContent 必须有 SheetTitle） */}
          <SheetTitle className="text-sm font-semibold text-stone-800 mb-1 text-left">
            订阅资费变更速递
          </SheetTitle>
          <SheetDescription className="text-xs text-stone-500 mb-3 leading-relaxed text-left">
            将最近变更推送到你的 RSS 阅读器，或用 JSON 接口对接自己的工具（默认排除演示数据）。
          </SheetDescription>
          {panel}
        </SheetContent>
      </Sheet>
    )
  }

  // 桌面端：锚点 Popover（原有形态）
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-3 max-h-[70vh] overflow-y-auto overscroll-contain"
      >
        {/* 桌面端普通标签头部（视觉与移动端 SheetTitle 一致） */}
        <div className="text-sm font-semibold text-stone-800 mb-1">订阅资费变更速递</div>
        <p className="text-xs text-stone-500 mb-3 leading-relaxed">
          将最近变更推送到你的 RSS 阅读器，或用 JSON 接口对接自己的工具。
        </p>
        {panel}
      </PopoverContent>
    </Popover>
  )
}

/** 导出当前筛选条件下的变更事件 CSV（与时间轴筛选同步，含高级筛选） */
function ExportEventsButton({
  days,
  category,
  type,
  source,
  q,
  date,
  month,
  year,
  catIn,
  catOut,
  content,
  priceMin,
  priceMax,
  totalDays,
}: {
  days: string
  category: string
  type: string
  source: string
  q: string
  date: string
  month: string
  year: string
  catIn: string
  catOut: string
  content: string
  priceMin: string
  priceMax: string
  totalDays: number
}) {
  const [exporting, setExporting] = useState(false)

  const buildPath = () => {
    const sp = new URLSearchParams()
    sp.set('kind', 'events')
    // 范围优先级与 API 一致：month > year > date > days
    if (month) {
      sp.set('month', month)
    } else if (year) {
      sp.set('year', year)
    } else {
      if (date) sp.set('date', date)
      if (days) sp.set('days', days)
    }
    if (category) sp.set('category', category)
    if (type) sp.set('type', type)
    if (source) sp.set('source', source)
    if (q) sp.set('q', q)
    // 高级筛选
    if (catIn) sp.set('catIn', catIn)
    if (catOut) sp.set('catOut', catOut)
    if (content) sp.set('content', content)
    if (priceMin) sp.set('priceMin', priceMin)
    if (priceMax) sp.set('priceMax', priceMax)
    return `/api/export?${sp.toString()}`
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const url = buildPath()
      const res = await fetch(url)
      if (!res.ok) throw new Error(`导出失败（${res.status}）`)
      const blob = await res.blob()
      const link = document.createElement('a')
      link.href = URL.createObjectURL(blob)
      link.download = `tariff-events-${new Date().toISOString().slice(0, 10)}.csv`
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(link.href)
      toast.success(`已导出当前筛选下 ${totalDays} 个变更日的事件 CSV`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <button
      onClick={handleExport}
      disabled={exporting || totalDays === 0}
      title="导出当前筛选的事件 CSV"
      className="inline-flex items-center gap-1 h-8 px-2.5 rounded-md border border-teal-300 bg-teal-50 text-teal-700 text-xs font-medium hover:bg-teal-100 transition-colors disabled:opacity-50"
    >
      {exporting ? (
        <RefreshCw className="size-3.5 animate-spin" />
      ) : (
        <Download className="size-3.5" />
      )}
      导出
    </button>
  )
}
