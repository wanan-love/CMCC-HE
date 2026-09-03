'use client'

import { useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { SlidersHorizontal, RotateCcw, Check } from 'lucide-react'
import {
  type AdvancedFilters,
  type TariffItem,
  advancedCount,
  EMPTY_ADVANCED,
} from './api'

/** 高级筛选可选的资费类型（与库内实际分类对齐） */
export const FILTER_CATEGORIES = ['套餐', '加装包', '营销活动', '港澳台/国际资费']

const CATEGORY_SWATCH: Record<string, string> = {
  套餐: 'bg-amber-100 text-amber-800 border-amber-200',
  加装包: 'bg-teal-100 text-teal-800 border-teal-200',
  营销活动: 'bg-pink-100 text-pink-800 border-pink-200',
  '港澳台/国际资费': 'bg-cyan-100 text-cyan-800 border-cyan-200',
}

/** 高级筛选数值的合法性整理（提交给 API 前的兜底） */
export function sanitizeAdvanced(f: AdvancedFilters): AdvancedFilters {
  const pm = f.priceMin.trim()
  const pM = f.priceMax.trim()
  const min = /^\d+(\.\d+)?$/.test(pm) ? pm : ''
  const max = /^\d+(\.\d+)?$/.test(pM) ? pM : ''
  return {
    cats: f.cats.filter((c) => FILTER_CATEGORIES.includes(c)),
    catMode: f.catMode === 'exclude' ? 'exclude' : 'include',
    content: f.content.trim(),
    priceMin: min,
    priceMax: max,
  }
}

/**
 * 高级筛选弹出面板（受控组件）
 * —— 资费类型多选（仅看 / 排除）、套餐内容包含关键词、价格区间
 * 文本输入采用草稿模式：键入不触发查询，失焦 / 回车 / 点「完成」才提交（避免每字符一次请求）
 * 时间轴 / 资费库 / 下线倒计时三个视图共用。
 */
export function AdvancedFilterPopover({
  value,
  onChange,
  resultHint,
}: {
  value: AdvancedFilters
  onChange: (v: AdvancedFilters) => void
  /** 结果数提示（如「0 个结果」由父组件传入，可选） */
  resultHint?: string | null
}) {
  const [open, setOpen] = useState(false)
  // 文本草稿（打开时从外部值初始化；提交才同步到查询）
  const [draft, setDraft] = useState({ content: value.content, priceMin: value.priceMin, priceMax: value.priceMax })
  const active = advancedCount(value)

  /** 打开面板时从外部受控值初始化草稿（事件回调内 setState，避免 effect 级联渲染） */
  const handleOpenChange = (o: boolean) => {
    if (o) setDraft({ content: value.content, priceMin: value.priceMin, priceMax: value.priceMax })
    setOpen(o)
  }

  /** 提交草稿（套餐内容 / 价格区间）到外部受控值 */
  const commit = () => {
    if (
      draft.content !== value.content ||
      draft.priceMin !== value.priceMin ||
      draft.priceMax !== value.priceMax
    ) {
      onChange({ ...value, content: draft.content, priceMin: draft.priceMin, priceMax: draft.priceMax })
    }
  }

  const toggleCat = (c: string) => {
    const next = value.cats.includes(c)
      ? value.cats.filter((x) => x !== c)
      : [...value.cats, c]
    onChange({ ...value, cats: next })
  }

  const setMode = (mode: 'include' | 'exclude') => {
    onChange({ ...value, catMode: mode })
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={`h-8 text-xs gap-1.5 relative ${
            active > 0
              ? 'border-teal-400 text-teal-700 bg-teal-50 hover:bg-teal-100'
              : 'border-stone-200 text-stone-600 hover:border-teal-300 hover:text-teal-700'
          }`}
          aria-label="高级筛选"
        >
          <SlidersHorizontal className="size-3.5" />
          高级筛选
          {active > 0 && (
            <Badge className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 text-[9px] bg-teal-600 text-white hover:bg-teal-600 rounded-full flex items-center justify-center">
              {active}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-4 space-y-4" data-testid="advanced-filter">
        {/* 资费类型：多选 + 包含/排除 */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-semibold text-stone-700">资费类型</div>
            <div className="inline-flex rounded-md border border-stone-200 overflow-hidden text-[10px]">
              <button
                onClick={() => setMode('include')}
                className={`px-2 py-0.5 transition-colors ${
                  value.catMode === 'include'
                    ? 'bg-teal-600 text-white'
                    : 'bg-white text-stone-500 hover:bg-stone-50'
                }`}
                title="仅显示勾选的类型"
              >
                仅看所选
              </button>
              <button
                onClick={() => setMode('exclude')}
                className={`px-2 py-0.5 transition-colors ${
                  value.catMode === 'exclude'
                    ? 'bg-rose-500 text-white'
                    : 'bg-white text-stone-500 hover:bg-stone-50'
                }`}
                title="排除勾选的类型"
              >
                排除所选
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {FILTER_CATEGORIES.map((c) => {
              const checked = value.cats.includes(c)
              return (
                <label
                  key={c}
                  className="flex items-center gap-2 rounded-md border px-2 py-1.5 cursor-pointer transition-colors select-none"
                  aria-label={c}
                  data-testid={`adv-cat-${c}`}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggleCat(c)}
                    className={checked ? 'data-[state=checked]:bg-teal-600 data-[state=checked]:border-teal-600' : ''}
                  />
                  <span
                    className={`text-[11px] rounded px-1 py-0.5 border ${
                      CATEGORY_SWATCH[c] ?? 'bg-stone-100 text-stone-700 border-stone-200'
                    }`}
                  >
                    {c}
                  </span>
                </label>
              )
            })}
          </div>
          {value.cats.length > 0 && (
            <div className="text-[10px] text-stone-400">
              {value.catMode === 'include' ? '仅显示' : '排除'}
              {value.cats.join('、')}
              {value.catMode === 'include' ? '' : '，其余类型全部保留'}
            </div>
          )}
        </div>

        {/* 套餐内容包含（草稿：失焦 / 回车提交） */}
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-stone-700">套餐内容包含</div>
          <Input
            value={draft.content}
            onChange={(e) => setDraft((d) => ({ ...d, content: e.target.value }))}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
            }}
            placeholder="如：流量、宽带、亲情号…"
            className="h-8 text-xs"
            data-testid="adv-content"
          />
          <div className="text-[10px] text-stone-400">
            在套餐内容（套餐内流量 / 通话 / 宽带等字段）中搜索关键词，回车或失焦后生效
          </div>
        </div>

        {/* 价格区间（草稿：失焦 / 回车提交） */}
        <div className="space-y-1.5">
          <div className="text-xs font-semibold text-stone-700">
            价格区间 <span className="font-normal text-stone-400">（元/月）</span>
          </div>
          <div
            className="flex items-center gap-2"
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
            }}
          >
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              value={draft.priceMin}
              onChange={(e) => setDraft((d) => ({ ...d, priceMin: e.target.value }))}
              onBlur={commit}
              placeholder="最低"
              className="h-8 text-xs"
              data-testid="adv-price-min"
            />
            <span className="text-stone-300 text-xs">—</span>
            <Input
              type="number"
              inputMode="decimal"
              min={0}
              value={draft.priceMax}
              onChange={(e) => setDraft((d) => ({ ...d, priceMax: e.target.value }))}
              onBlur={commit}
              placeholder="最高"
              className="h-8 text-xs"
              data-testid="adv-price-max"
            />
          </div>
          <div className="text-[10px] text-stone-400">留空表示不限；未公示价格的资费不参与价格筛选</div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between pt-1 border-t border-stone-100">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs text-stone-500 hover:text-stone-700 px-2"
            onClick={() => {
              setDraft({ content: '', priceMin: '', priceMax: '' })
              onChange({ ...EMPTY_ADVANCED })
            }}
          >
            <RotateCcw className="size-3" />
            重置
          </Button>
          <div className="flex items-center gap-2">
            {resultHint != null && (
              <span className={`text-[11px] ${resultHint === '0' ? 'text-rose-500' : 'text-stone-400'}`}>
                {resultHint} 个结果
              </span>
            )}
            <Button
              size="sm"
              className="h-7 text-xs bg-teal-600 hover:bg-teal-700"
              onClick={() => {
                commit()
                setOpen(false)
              }}
            >
              <Check className="size-3" />
              完成
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/** 已生效的高级筛选条件摘要 chips（显示在筛选栏下方，可逐项 ✕ 清除） */
export function AdvancedFilterChips({
  value,
  onChange,
}: {
  value: AdvancedFilters
  onChange: (v: AdvancedFilters) => void
}) {
  const chips: { key: string; label: string; clear: () => void }[] = []
  if (value.cats.length) {
    chips.push({
      key: 'cats',
      label: `${value.catMode === 'include' ? '仅看' : '排除'}${value.cats.join('、')}`,
      clear: () => onChange({ ...value, cats: [] }),
    })
  }
  if (value.content.trim()) {
    chips.push({
      key: 'content',
      label: `内容含「${value.content.trim()}」`,
      clear: () => onChange({ ...value, content: '' }),
    })
  }
  if (value.priceMin.trim() || value.priceMax.trim()) {
    const lo = value.priceMin.trim()
    const hi = value.priceMax.trim()
    chips.push({
      key: 'price',
      label: lo && hi ? `${lo}~${hi}元/月` : lo ? `≥${lo}元/月` : `≤${hi}元/月`,
      clear: () => onChange({ ...value, priceMin: '', priceMax: '' }),
    })
  }
  if (chips.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="adv-chips">
      {chips.map((c) => (
        <button
          key={c.key}
          onClick={c.clear}
          title="点击清除该条件"
          className="inline-flex items-center gap-1 px-2 h-6 text-[11px] rounded-full border border-teal-200 bg-teal-50 text-teal-700 hover:bg-teal-100 transition-colors"
        >
          {c.label}
          <span aria-hidden className="text-teal-400">✕</span>
        </button>
      ))}
    </div>
  )
}

/** 前端兜底过滤（服务端已过滤，此函数用于本地二次校验/数据一致性展示） */
export function matchesAdvanced(
  t: TariffItem | { category: string; priceValue: number | null; usageJson?: string },
  f: AdvancedFilters
): boolean {
  if (f.cats.length) {
    const inSet = f.cats.includes(t.category)
    if (f.catMode === 'include' && !inSet) return false
    if (f.catMode === 'exclude' && inSet) return false
  }
  const kw = f.content.trim().toLowerCase()
  if (kw && t.usageJson && !t.usageJson.toLowerCase().includes(kw)) return false
  const lo = parseFloat(f.priceMin)
  const hi = parseFloat(f.priceMax)
  if ((!isNaN(lo) || !isNaN(hi)) && t.priceValue == null) return false
  if (!isNaN(lo) && (t.priceValue ?? 0) < lo) return false
  if (!isNaN(hi) && (t.priceValue ?? Infinity) > hi) return false
  return true
}
