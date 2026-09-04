'use client'

import { useState, useRef, useEffect, useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Download, MousePointerClick } from 'lucide-react'
import { toast } from 'sonner'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
} from 'recharts'
import { useInsights } from './api'

const PIE_COLORS = ['#059669', '#0d9488', '#d97706', '#db2777', '#0891b2', '#78716c', '#a16207']

/** 分类 → 堆积图固定色（全类型覆盖；与 CATEGORY_COLORS 色系对齐，不含蓝/靓蓝） */
const CATEGORY_HEX: Record<string, string> = {
  套餐: '#059669',
  加装包: '#0d9488',
  营销活动: '#d97706',
  '港澳台/国际资费': '#db2777',
  标准资费: '#ea580c',
  国际及港澳台标准资费: '#c026d3',
  其他: '#78716c',
  港澳台国际: '#0891b2',
}
/** 图例/提示框里的分类短名（过长的港澳台系简化） */
const shortCat = (c: string) =>
  c === '港澳台/国际资费' || c === '港澳台国际'
    ? '港澳台/国际'
    : c === '国际及港澳台标准资费'
      ? '国际及港澳台标准'
      : c

const fieldLabels: Record<string, string> = {
  name: '分类',
  value: '数量',
  month: '月份',
  count: '数量',
}

/** 把图表 Card 内的 SVG 导出为 PNG（白底 + 标题，2 倍分辨率） */
async function exportChartPng(title: string, svg: SVGSVGElement) {
  // 尺寸：优先布局尺寸，回退 viewBox
  const rect = svg.getBoundingClientRect()
  const w = Math.max(1, Math.round(rect.width || svg.viewBox.baseVal?.width || 600))
  const h = Math.max(1, Math.round(rect.height || svg.viewBox.baseVal?.height || 300))

  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))

  const xml = new XMLSerializer().serializeToString(clone)
  const dataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)

  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('SVG 渲染失败'))
    img.src = dataUrl
  })

  const SCALE = 2
  const TITLE_H = 44
  const canvas = document.createElement('canvas')
  canvas.width = w * SCALE
  canvas.height = (h + TITLE_H) * SCALE
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas 不可用')

  // 白底
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  // 标题
  ctx.fillStyle = '#1c1917'
  ctx.font = `bold ${16 * SCALE}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.fillText(title, 16 * SCALE, (TITLE_H / 2) * SCALE)
  // 副标题（数据快照时间）
  ctx.fillStyle = '#a8a29e'
  ctx.font = `${10 * SCALE}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`
  const stamp = `河北移动资费观察 · 导出于 ${new Date().toLocaleString('zh-CN')}`
  const tw = ctx.measureText(stamp).width
  ctx.fillText(stamp, canvas.width - tw - 16 * SCALE, (TITLE_H / 2) * SCALE)
  // 图表
  ctx.drawImage(img, 0, TITLE_H * SCALE, w * SCALE, h * SCALE)

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) throw new Error('PNG 生成失败')

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${title.replace(/[\\/:*?"<>|]/g, '_')}.png`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

/** 可导出图表卡片：标题行右侧下载按钮，导出 CardContent 内首个 SVG */
function ChartCard({
  title,
  heightClass,
  spanClass,
  sectionId,
  hint,
  children,
}: {
  title: string
  heightClass: string
  spanClass?: string
  /** 锚点快速导航的分区 id */
  sectionId?: string
  /** 副标题提示（如"点击柱形下钻"） */
  hint?: string
  children: React.ReactNode
}) {
  const contentRef = useRef<HTMLDivElement>(null)
  const [exporting, setExporting] = useState(false)

  const handleExport = async () => {
    const svg = contentRef.current?.querySelector('svg')
    if (!svg) {
      toast.error('未找到图表元素')
      return
    }
    setExporting(true)
    try {
      await exportChartPng(title, svg as SVGSVGElement)
      toast.success(`已导出「${title}」PNG`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Card id={sectionId} className={`border-stone-200 shadow-sm scroll-mt-28 ${spanClass ?? ''}`}>
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <div className="min-w-0 pr-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          {hint && (
            <p className="text-[10px] text-stone-400 mt-0.5 flex items-center gap-1">
              <MousePointerClick className="size-3 shrink-0" />
              {hint}
            </p>
          )}
        </div>
        <button
          onClick={handleExport}
          disabled={exporting}
          title="导出为 PNG 图片"
          aria-label={`导出${title}`}
          className="shrink-0 inline-flex items-center justify-center size-7 rounded-md text-stone-400
            hover:text-teal-700 hover:bg-teal-50 hover:border-teal-200 border border-transparent
            transition-colors disabled:opacity-50"
        >
          <Download className="size-3.5" />
        </button>
      </CardHeader>
      <CardContent ref={contentRef} className={heightClass}>
        {children}
      </CardContent>
    </Card>
  )
}

/** 洞察页分区锚点快速导航（合并后 6 图，sticky 在页头下方；滚动感知高亮；
    移动端仅展示 core 核心项，避免 chips 挤压） */
const INSIGHT_SECTIONS: { id: string; label: string; core?: boolean }[] = [
  { id: 'ins-compare', label: '上/下/变', core: true },
  { id: 'ins-cat', label: '分类构成' },
  { id: 'ins-catpie', label: '分类占比', core: true },
  { id: 'ins-planprice', label: '套餐价格', core: true },
  { id: 'ins-addonprice', label: '加装包价格' },
  { id: 'ins-year', label: '年度', core: true },
]

function InsightsNav({ sections }: { sections: { id: string; label: string; core?: boolean }[] }) {
  const [active, setActive] = useState('')

  /** 滚动感知：进入视口顶部判定区（页面头 61px + 导航条 ~30px + 缓冲）的分区即为当前分区 */
  const navRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const els = sections
      .map((s) => document.getElementById(s.id))
      .filter((el): el is HTMLElement => !!el)
    if (!els.length) return

    const onScroll = () => {
      // 判定线：导航条底部 + 1px（分区顶部越过此线即视为当前）
      const navBottom = navRef.current ? navRef.current.getBoundingClientRect().bottom : 100
      const line = Math.max(navBottom, 0) + 1
      let current = ''
      for (const el of els) {
        if (el.getBoundingClientRect().top <= line) current = el.id
      }
      // 滚动到最底部时强制最后一个（最底部分区可能永远越不过判定线）
      const scrolledToBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4
      if (scrolledToBottom) current = els[els.length - 1].id
      setActive(current)
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [sections])

  const jump = (id: string) => {
    const el = document.getElementById(id)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      history.replaceState(null, '', `#${id}`)
    }
  }
  return (
    <div ref={navRef} className="sticky top-[61px] z-30 -mx-1 px-1 py-1.5 bg-stone-50/80 backdrop-blur-sm border-b border-stone-100">
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
        <span className="text-[10px] text-stone-400 shrink-0 pr-0.5">快速跳转</span>
        {sections.map((s) => (
          <button
            key={s.id}
            onClick={() => jump(s.id)}
            className={`px-2 h-6 text-[11px] rounded-full border whitespace-nowrap transition-colors ${
              // 移动端仅展示核心项（4 个），非 core 在 sm 及以上展示
              s.core ? '' : 'hidden sm:inline-flex'
            } ${
              active === s.id
                ? 'bg-teal-600 text-white border-teal-600'
                : 'bg-white text-stone-600 border-stone-200 hover:border-teal-300 hover:text-teal-700'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function InsightsTab({
  onDrillToMonth,
  onDrillToPriceBand,
  onDrillToCategory,
  onDrillToYear,
}: {
  /** 点击月度图表柱形 → 下钻到该月时间轴（page 层写 ?month= 深链接） */
  onDrillToMonth?: (month: string) => void
  /** 点击价格 KPI 卡/价格分布图 → 下钻资费库价格带（page 层写 ?band= 深链接） */
  onDrillToPriceBand?: (band: string) => void
  /** 点击分类占比饼图扇区 → 下钻资费库对应分类（page 层写 ?category= 深链接） */
  onDrillToCategory?: (category: string) => void
  /** 点击年度图柱形 → 下钻该年时间轴（page 层写 ?year= 深链接） */
  onDrillToYear?: (year: string) => void
}) {
  const { data, isLoading } = useInsights()

  /** 堆积图的分类系列：数据里实际出现且有数值的分类键（month 之外），按全集顺序稳定排序 */
  const catKeys = useMemo(() => {
    const order = [...Object.keys(CATEGORY_HEX)]
    const seen = new Set<string>()
    for (const row of data?.categoryMonthly ?? []) {
      for (const [k, v] of Object.entries(row)) {
        if (k !== 'month' && Number(v) > 0) seen.add(k)
      }
    }
    return [...seen].sort((a, b) => {
      const ia = order.indexOf(a)
      const ib = order.indexOf(b)
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
  }, [data?.categoryMonthly])

  /** 柱形单击下钻：Bar 级 onClick 直接携带该柱的 payload（month 字段） */
  const handleBarClick = (data: unknown) => {
    const payload = (data as { payload?: { month?: unknown } } | null)?.payload
    const month = payload?.month
    if (typeof month === 'string' && /^\d{4}-\d{2}$/.test(month) && onDrillToMonth) {
      onDrillToMonth(month)
    }
  }

  /** 价格分布图柱形点击 → 下钻资费库对应价格带 */
  const handlePlanPriceBarClick = (data: unknown) => {
    const payload = (data as { payload?: { key?: unknown } } | null)?.payload
    const key = payload?.key
    if (typeof key === 'string' && onDrillToPriceBand) {
      onDrillToPriceBand(key)
    }
  }

  /** 分类占比饼图扇区点击 → 下钻资费库对应分类（兼容 payload.name 与顶层 name 两种事件形状） */
  const handlePieClick = (entry: unknown) => {
    const e = entry as { name?: unknown; payload?: { name?: unknown } } | null
    const name = e?.payload?.name ?? e?.name
    if (typeof name === 'string' && name && onDrillToCategory) {
      onDrillToCategory(name)
    }
  }

  /** 年度图柱形点击 → 下钻该年时间轴（payload.year 为 YYYY 字符串） */
  const handleYearClick = (data: unknown) => {
    const payload = (data as { payload?: { year?: unknown } } | null)?.payload
    const year = payload?.year
    if (typeof year === 'string' && /^\d{4}$/.test(year) && onDrillToYear) {
      onDrillToYear(year)
    }
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-xl" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Skeleton key={i} className="h-72 rounded-xl" />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* 锚点快速导航（8 图 2 屏+，一键跳转） */}
      <InsightsNav sections={INSIGHT_SECTIONS} />

      {/* 价格统计 KPI 条（免费卡可下钻资费库） */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="套餐中位月费"
          value={data.priceStats.planMedian !== null ? `${data.priceStats.planMedian} 元` : '—'}
          sub={`${data.priceStats.planPriced} 个有价套餐 · ${data.priceStats.planFree} 个免费`}
          icon={<span className="text-xs">🛰</span>}
        />
        <StatCard
          label="加装包中位价"
          value={data.priceStats.addonMedian !== null ? `${data.priceStats.addonMedian} 元` : '—'}
          sub={`${data.priceStats.addonPriced} 个有价加装包 · ${data.priceStats.addonFree} 个免费`}
          icon={<span className="text-xs">🎁</span>}
        />
        <StatCard
          label="免费资源总量"
          value={`${data.priceStats.totalFree} 个`}
          sub="0 元资费（含营销/港澳台国际类）· 多为体验/权益类"
          icon={<span className="text-xs">🆓</span>}
          hint="点击在资费库查看全部免费资费 →"
          onClick={onDrillToPriceBand ? () => onDrillToPriceBand('free') : undefined}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      {/* 近 24 个月上线/下线/变更对比（原 24 个月单序列 + 12 个月三序列两张图合并；
          下钻：点击柱形 → 该月时间轴明细） */}
      <ChartCard
        title="近 24 个月上线 / 下线 / 变更对比（真实事件）"
        heightClass="h-64"
        spanClass="lg:col-span-2"
        sectionId="ins-compare"
        hint="点击某月份柱形 → 在时间轴中查看该月全部变更"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.monthlyChanges}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 10, fill: '#78716c' }}
              interval="preserveStartEnd"
              minTickGap={12}
              tickFormatter={(v: string) => v.slice(2)}
            />
            <YAxis tick={{ fontSize: 10, fill: '#78716c' }} width={36} allowDecimals={false} />
            <Tooltip
              formatter={(v: number, n: string) => [`${v} 个`, n]}
              labelFormatter={(l: string) => `${l}`}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e7e5e4' }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <Bar dataKey="added" name="上线" fill="#059669" radius={[3, 3, 0, 0]} maxBarSize={16} className="cursor-pointer" onClick={handleBarClick} />
            <Bar dataKey="removed" name="下线" fill="#e11d48" radius={[3, 3, 0, 0]} maxBarSize={16} className="cursor-pointer" onClick={handleBarClick} />
            <Bar dataKey="updated" name="变更" fill="#d97706" radius={[3, 3, 0, 0]} maxBarSize={16} className="cursor-pointer" onClick={handleBarClick} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 近 24 个月新上线分类构成（堆积图，看结构变化；与上/下/变合并图同窗口） */}
      <ChartCard
        title="近 24 个月新上线分类构成（按月堆积）"
        heightClass="h-64"
        spanClass="lg:col-span-2"
        sectionId="ins-cat"
        hint="点击某月份柱形 → 在时间轴中查看该月上线明细"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.categoryMonthly}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
            <XAxis
              dataKey="month"
              tick={{ fontSize: 10, fill: '#78716c' }}
              interval="preserveStartEnd"
              minTickGap={12}
              tickFormatter={(v: string) => v.slice(2)}
            />
            <YAxis tick={{ fontSize: 10, fill: '#78716c' }} width={36} allowDecimals={false} />
            <Tooltip
              formatter={(v: number, n: string) => [`${v} 个`, shortCat(n)]}
              labelFormatter={(l: string) => `${l}`}
              contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e7e5e4' }}
            />
            <Legend formatter={(v: string) => shortCat(v)} wrapperStyle={{ fontSize: 11 }} />
            {/* 分类系列动态渲染：数据里有哪些分类就画哪些（含标准资费等全类型） */}
            {catKeys.map((k) => (
              <Bar
                key={k}
                dataKey={k}
                stackId="cat"
                name={k}
                fill={CATEGORY_HEX[k] ?? '#a8a29e'}
                maxBarSize={32}
                className="cursor-pointer"
                onClick={handleBarClick}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 分类分布（饼图扇区可点击 → 下钻资费库对应分类） */}
      <ChartCard
        title="资费分类分布"
        heightClass="h-72"
        sectionId="ins-catpie"
        hint="点击某分类扇区 → 在资费库查看该分类全部资费"
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data.byCategory}
              dataKey="value"
              nameKey="name"
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={85}
              paddingAngle={2}
              label={({ name, value }) => `${name} ${value}`}
              labelLine={{ strokeWidth: 0.5 }}
              className="cursor-pointer"
              onClick={handlePieClick}
            >
              {data.byCategory.map((_, i) => (
                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(v: number, n: string) => [`${v} 个`, fieldLabels[n] ?? n]}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
          </PieChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 价格分布（套餐） */}
      <ChartCard
        title="套餐月费分布"
        heightClass="h-72"
        sectionId="ins-planprice"
        hint="点击某价格带柱形 → 在资费库查看该价位套餐"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.priceBuckets} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10, fill: '#78716c' }} />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11, fill: '#57534e' }}
              width={70}
            />
            <Tooltip
              formatter={(v: number) => [`${v} 个套餐`, '数量']}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Bar dataKey="count" fill="#0d9488" radius={[0, 4, 4, 0]} maxBarSize={22} className="cursor-pointer" onClick={handlePlanPriceBarClick} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 价格分布（加装包） */}
      <ChartCard
        title="加装包价格分布（价格带更细）"
        heightClass="h-72"
        sectionId="ins-addonprice"
        hint="点击某价格带柱形 → 在资费库查看该价位加装包"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.addonPriceBuckets} layout="vertical">
            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 10, fill: '#78716c' }} allowDecimals={false} />
            <YAxis
              type="category"
              dataKey="name"
              tick={{ fontSize: 11, fill: '#57534e' }}
              width={70}
            />
            <Tooltip
              formatter={(v: number) => [`${v} 个加装包`, '数量']}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Bar dataKey="count" fill="#a16207" radius={[0, 4, 4, 0]} maxBarSize={22} className="cursor-pointer" onClick={handlePlanPriceBarClick} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>

      {/* 年度上线数量（可下钻：点击某年份 → 该年时间轴明细） */}
      <ChartCard
        title="历年上线资费数量（2016 年起）"
        heightClass="h-56"
        spanClass="lg:col-span-2"
        sectionId="ins-year"
        hint="点击某年份柱形 → 在时间轴中查看该年全部上线事件"
      >
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data.byYear}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e7e5e4" />
            <XAxis dataKey="year" tick={{ fontSize: 10, fill: '#78716c' }} />
            <YAxis tick={{ fontSize: 10, fill: '#78716c' }} width={36} />
            <Tooltip
              formatter={(v: number) => [`${v} 个`, '新上线']}
              contentStyle={{ fontSize: 12, borderRadius: 8 }}
            />
            <Bar dataKey="count" fill="#a16207" radius={[4, 4, 0, 0]} maxBarSize={32} className="cursor-pointer" onClick={handleYearClick} />
          </BarChart>
        </ResponsiveContainer>
      </ChartCard>
      </div>
    </div>
  )
}

/** 统计小卡片（洞察页顶部 KPI 条；可点击下钻：价格卡 → 资费库价格带筛选，免费卡 → 资费库免费筛选） */
function StatCard({
  label,
  value,
  sub,
  icon,
  hint,
  onClick,
}: {
  label: string
  value: string
  sub: string
  icon: React.ReactNode
  /** 可点击时的提示文案（如"点击查看免费资费 →"） */
  hint?: string
  onClick?: () => void
}) {
  const interactive = !!onClick
  return (
    <Card
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `${label}，${hint ?? ''}` : undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={(e) => {
        if (interactive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onClick?.()
        }
      }}
      className={`border-stone-200 shadow-sm transition-all duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-400 ${
        interactive
          ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 hover:border-teal-300'
          : ''
      }`}
    >
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-xs text-stone-500 mb-1.5">
          {icon}
          <span>{label}</span>
          {interactive && <MousePointerClick className="size-3 text-teal-500 ml-auto shrink-0" aria-hidden="true" />}
        </div>
        <div className="text-2xl font-bold tabular-nums text-stone-800 tracking-tight">{value}</div>
        <div className="text-[11px] text-stone-400 mt-1">{sub}</div>
        {interactive && hint && (
          <div className="text-[10px] text-teal-600 mt-1.5 group-hover:text-teal-700">{hint}</div>
        )}
      </CardContent>
    </Card>
  )
}
