/**
 * 中国移动河北资费公示抓取 —— GitHub Actions / 本地通用版（Playwright）
 * 运行: node scripts/scrape.mjs   （需先: npm i playwright && npx playwright install --with-deps chromium）
 * 冒烟: SCRAPE_SMOKE=1 node scripts/scrape.mjs  （验证导航+选择器+类型枚举健康，不落盘）
 *
 * 采集范围：仅「个人资费 · 河北省专属」，但覆盖【全部资费类型】——
 *   套餐 / 加装包 / 营销活动 / 港澳台(国际)资费 / 标准资费（以及页面动态提供的
 *   国际及港澳台标准资费、其他）。类型下拉选项在运行时动态枚举，页面未来增删
 *   类型无需改本脚本。
 *
 * ── 逆向接口齐全性校验（2026-09-04 逆向自页面 JS bundle）──────────────────
 * 前端结构：tariffZonePers.html → Vue + webpack 动态 chunk
 *   （tariffZonePers.js 入口 + templateCollection.js 模板集 + chunk 155 NavBarNew
 *    导航/列表分页 + chunk 837 tariffSerial 卡片 + chunk 929/715/88/814 标准资费表格）
 * 关键接口（base https://h.app.coc.10086.cn）：
 *   1) 列表分页 POST /website/nrapigate/nrtariff/new/Tariff/getTariffListInfo
 *      body {cellNum:'99999999999', province:'311', isPublic:'1', linkScn:'1',
 *            tariffAttr:'1'全网|'2'分省, type1:'1'个人|'2'政企, type2:'1'..'7',
 *            page, limit:5}
 *      resp rspBody.(data?).{page:{total,pageNumber,pageSize}, beans:[卡片原始数据]}
 *   2) 标准资费 POST /website/nrapigate/nrtariff/new/Tariff/getStandardlist
 *      body {province, isPublic:'1'}
 *      resp rspBody[0].tariffTable 或 rspBody.tariffList[0].tariffTable =
 *           {tHead:[{任意键:列名}], tBody:[{任意键:单元格值}]}
 *   3) 类型可用性 POST /website/nrapigate/nrtariff/new/Tariff/getType2List
 *   4) 类型值映射（bundle chunk-155 module 0x15ae 硬编码）：
 *      1套餐 2加装包 3营销活动 4港澳台/国际资费 5标准资费(特殊'标准资费VALUE'，
 *      仅分省页签且标准数据存在时出现在下拉中，不走列表 API) 6国际及港澳台标准资费 7其他
 *   5) 懒加载：scroll-flag 元素进入视口触发下一页（每页 5 条）
 *
 *   本脚本在浏览器侧拦截以上 XHR 响应：以接口声明的 page.total 为基准逐一核对
 *   每个类型实际抓到的 DOM 卡片数（DOM = API beans 的渲染结果，理论应严格相等），
 *   不足即自愈重抓，仍不足则本脚本以非零码失败 → workflow 不推送，杜绝漏抓上线。
 *
 * 网络出口：GitHub Actions 中由 workflow 先连接 Cloudflare WARP（TUN 或 docker
 *   socks5 代理），Chromium 的全部请求自然经 WARP 出口，避免数据中心 IP 被风控。
 *   注入 WARP_SOCKS 环境变量时 Chromium 走 socks5 代理（效果等价，推送 API 走直连）。
 *
 * 真人节奏（防风控核心，处处随机不可预测）：
 *   1. 所有等待均带随机抖动 jitter(min,max)——没有两次运行的节奏相同；
 *   2. 滚动是「浏览式」而非「机器式」：每轮 1~3 小步滚动 + 轮末直跳绝对底部（懒加载触发器），
 *      步间 0.8~1.8s，轮间 2~5s，15% 概率 5~9s「阅读停留」；
 *   3. 切类型/切页签 8~16s、重试冷却 60~90s 大间隔随机；
 *   4. 视口尺寸微随机（宽 1346~1386 / 高 870~930）；
 *   5. 偶发鼠标轨迹漂移（mouseDrift），补充真实指针事件。
 *
 * 输出: seed/p_h_<类型>.json（各类型卡片数组，卡片内含 _sourceType 标记来源类型，
 *   供 normalize.mjs 归类兜底）；seed/api/api-report.json（逆向接口齐全性报告）。
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = process.env.SCRAPE_OUT_DIR || join(__dirname, '..', 'seed')
const API_DUMP_DIR = join(OUT_DIR, 'api')
const SMOKE = !!process.env.SCRAPE_SMOKE
const URL =
  'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html?pageId=834148205904408576&prov=531'

/** 类型值映射（逆向自 chunk-155 module 0x15ae：label ↔ type2 值） */
const TYPE_VALUE = {
  套餐: '1',
  加装包: '2',
  营销活动: '3',
  '港澳台/国际资费': '4',
  标准资费: '5',
  国际及港澳台标准资费: '6',
  其他: '7',
}
/** 标准资费在下拉中的特殊值（选中后容器切换为 StandarTariff 表格视图，不走列表 API） */
const STANDARD_VALUE = '标准资费VALUE'
/** 采集范围固定：个人(type1='1') × 河北分省(tariffAttr='2') */
const SCOPE_KEY = `1|2|`

mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(API_DUMP_DIR, { recursive: true })

/** 随机数工具：[min, max) 浮点 */
const rand = (min, max) => min + Math.random() * (max - min)

const startedAt = Date.now()
const tlog = (msg) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${msg}`)

/** 文件名安全化（'港澳台/国际资费' → '港澳台_国际资费'） */
const fileSafe = (s) => s.replace(/\//g, '_')

const browser = await chromium.launch({
  headless: true,
  // WARP SOCKS 代理模式降级：workflow 注入 WARP_SOCKS 时 Chromium 走本地 socks5 代理
  ...(process.env.WARP_SOCKS ? { proxy: { server: process.env.WARP_SOCKS } } : {}),
})

/**
 * 创建一个 worker（= 一个"虚拟用户"）：
 * 独立 browser context（独立 cookie/存储）、独立微随机视口、独立日志前缀与节奏序列。
 */
async function createWorker(id) {
  const viewport = {
    width: Math.round(rand(1346, 1386)),
    height: Math.round(rand(870, 930)),
  }
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.round(
    rand(126, 129)
  )}.0.0.0 Safari/537.36`
  const context = await browser.newContext({ userAgent: ua, viewport })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)

  /* ---------- 逆向接口拦截（齐全性校验的数据源） ---------- */
  const api = {
    /** key = `${type1}|${tariffAttr}|${type2}` → {total, beans, pages, lastSeen} */
    lists: new Map(),
    /** getStandardlist 原始响应（选省后自动触发） */
    standard: null,
    /** getType2List 原始响应（页面可用类型清单） */
    typesList: null,
  }
  page.on('response', async (resp) => {
    try {
      const url = resp.url()
      if (!/nrapigate\/nrtariff/.test(url)) return
      const method = resp.request().method()
      if (method !== 'POST') return
      const body = await resp.json().catch(() => null)
      if (!body) return

      if (url.includes('getTariffListInfo')) {
        const req = JSON.parse(resp.request().postData() || '{}')
        const key = `${req.type1}|${req.tariffAttr}|${req.type2}`
        const data = body?.rspBody?.data ?? body?.rspBody ?? {}
        const total = Number(data?.page?.total ?? 0) || 0
        const beansN = Array.isArray(data?.beans) ? data.beans.length : 0
        const e = api.lists.get(key) || { total: 0, beans: 0, pages: 0 }
        if (total > e.total) e.total = total
        e.beans += beansN
        e.pages += 1
        e.label = Object.keys(TYPE_VALUE).find((l) => TYPE_VALUE[l] === req.type2)
        api.lists.set(key, e)
      } else if (url.includes('getStandardlist')) {
        api.standard = body
      } else if (url.includes('getType2List')) {
        api.typesList = body
      }
    } catch {
      /* 拦截失败不影响主流程（齐全性报告会显式暴露缺失） */
    }
  })

  const w = {
    id,
    context,
    page,
    viewport,
    api,
    log: (msg) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s w${id}] ${msg}`),
    jitter: (minS, maxS) => page.waitForTimeout(rand(minS, maxS) * 1000),
  }
  w.log(`worker 启动：视口=${viewport.width}x${viewport.height}`)
  return w
}

/** 偶发鼠标漂移：视口内随机轨迹移动（约 40% 概率触发，为页面补充真实指针事件） */
async function mouseDrift(w) {
  if (Math.random() > 0.4) return
  await w.page.mouse.move(rand(80, w.viewport.width - 80), rand(60, w.viewport.height - 80), {
    steps: Math.floor(rand(3, 10)),
  })
}

/** 导航到公示页（带 1 次重试，网络偶发失败不至于直接崩掉整轮采集） */
async function navigate(w) {
  for (let i = 1; i <= 2; i++) {
    try {
      await w.page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 })
      return
    } catch (e) {
      if (i === 2) throw e
      w.log(`导航失败（${String(e.message).split('\n')[0]}），10s 后重试一次...`)
      await w.page.waitForTimeout(10000)
    }
  }
}

/** 等待加载指示消失（「努力加载中」文本不存在），轮询间隔也随机 */
async function waitIdle(w) {
  for (let i = 0; i < 15; i++) {
    const loading = await w.page.evaluate(() =>
      document.body.innerText.includes('努力加载中') ? '1' : '0'
    )
    if (loading === '0') break
    await w.jitter(1.5, 3)
  }
  await w.jitter(1.5, 3)
}

const countCards = (w) =>
  w.page.evaluate(() => document.querySelectorAll('.tariff-item-container').length)

/**
 * 真人式滚动收集：每轮若干小步浏览 + 直跳绝对底部（触发懒加载的关键），
 * 直到卡片数连续 10 轮无增长、已到页面真实底部、且底部 3 轮长复查无新增。
 *
 * 关键教训（生产实测）：懒加载以「到达/接近底部」为触发条件；纯小步平滑滚动
 * 可能始终到不了底部，且慢网络（WARP/跨境）下批次在途时停滞计数即成立 →
 * 提前终止漏抓。故：① 每轮末直跳绝对底部；② 停滞 10 轮 + 真底校验；
 * ③ 到底后最多 3 轮 8~15s 长复查（慢批次兜底，任一轮有新增即回主循环）。
 * @param maxRounds 最大滚动轮数（SMOKE 模式传小值快速验证）
 */
async function scrollAll(w, maxRounds = 120) {
  await waitIdle(w)
  const stallRounds = 10
  let stall = 0
  let last = 0
  for (let round = 0; round < maxRounds; round++) {
    const prev = await countCards(w)
    const steps = 1 + Math.floor(Math.random() * 3)
    for (let s = 0; s < steps; s++) {
      await w.page.evaluate(() => {
        const h = window.innerHeight * (0.8 + Math.random() * 0.7)
        window.scrollBy({ top: h, behavior: 'instant' })
      })
      await w.jitter(0.8, 1.8)
    }
    await mouseDrift(w)
    // 直跳绝对底部（模拟 End 键）——懒加载触发器
    await w.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await (Math.random() < 0.15 ? w.jitter(5, 9) : w.jitter(2, 5))
    const now = await countCards(w)
    stall = prev === now ? stall + 1 : 0
    last = now
    if (stall >= stallRounds && now !== 0) {
      const atBottom = await w.page.evaluate(
        () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 100
      )
      if (atBottom) {
        let confirmed = true
        for (let r = 0; r < 3; r++) {
          await w.jitter(8, 15)
          const again = await countCards(w)
          if (again > now) {
            confirmed = false
            stall = 0
            last = again
            break
          }
        }
        if (confirmed) break
      } else {
        stall = Math.floor(stall / 2)
      }
    }
  }
  // 平滑回到顶部（类型切换控件在页首；浏览完回看顶部也更像真人）
  await w.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }))
  await w.jitter(1.2, 2.5)
  return last
}

/** 重新导航（重置 Vue 状态）+ 选河北省 + 等待初始加载 */
async function resetToHebei(w) {
  await navigate(w)
  await w.jitter(8, 14)
  await mouseDrift(w)
  await w.page.evaluate(() => {
    document.querySelector('.prov-entry')?.click()
  })
  await w.jitter(1.5, 3)
  await w.page.evaluate(() => {
    const items = [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && (e.innerText || '').trim() === '河北省'
    )
    items.forEach((e) => e.click())
  })
  await w.jitter(6, 10)
  await waitIdle(w)
}

/** 提取当前页全部资费卡片（选择器经生产数据验证：tariffSerial chunk-837） */
async function extractCards(w) {
  return w.page.evaluate(() => {
    const cards = [...document.querySelectorAll('.tariff-item-container')]
    const out = []
    for (const c of cards) {
      const name = c.querySelector('.item-name')?.innerText?.trim() || ''
      const tips = [...c.querySelectorAll('.item-tips-list .tips-attr, .item-tips-list .tips-content')]
      const fields = {}
      let lastLabel = null
      for (const el of tips) {
        const txt = (el.innerText || '').trim()
        if (el.classList.contains('tips-attr')) {
          lastLabel = txt.replace(/[:：]\s*$/, '')
        } else if (lastLabel) {
          fields[lastLabel] = txt
          lastLabel = null
        }
      }
      const ta = c.querySelector('.table-area')
      const usage = []
      if (ta) {
        const parts = (ta.innerText || '').trim().split(/\n+/).filter(Boolean)
        for (let i = 0; i + 1 < parts.length; i += 2) usage.push({ label: parts[i], value: parts[i + 1] })
      }
      const gray = {}
      const grayText = c.querySelector('.list-gray')?.innerText || ''
      const labels = ['超出资费说明', '其他服务内容', '其他说明', '备注', '温馨提示']
      for (const lb of labels) {
        const re = new RegExp(lb + '[:：]\\s*')
        const m = grayText.match(re)
        if (m) {
          const start = m.index + m[0].length
          let end = grayText.length
          for (const lb2 of labels) {
            if (lb2 === lb) continue
            const re2 = new RegExp(lb2 + '[:：]')
            const m2 = grayText.slice(start).match(re2)
            if (m2) end = Math.min(end, start + m2.index)
          }
          gray[lb] = grayText.slice(start, end).trim()
        }
      }
      out.push({ name, fields, usage, gray })
    }
    return out
  })
}

/* ---------- 资费类型下拉操作（NavBarNew chunk-155 MySelect DOM） ---------- */

/** 打开类型下拉（点 .select-box），返回 'ok' | 'nf' */
async function openTypeDropdown(w) {
  await mouseDrift(w)
  const res = await w.page.evaluate(() => {
    const labels = [...document.querySelectorAll('.select-label')]
    const lb = labels.find((el) => (el.innerText || '').trim().replace(/[:：]/, '') === '资费类型')
    let box = null
    if (lb) box = lb.parentElement?.querySelector('.select-box')
    if (!box) box = document.querySelector('.select-box')
    if (!box) return 'nf'
    box.click()
    return 'ok'
  })
  await w.jitter(1.2, 2.5)
  return res
}

/** 枚举当前展开下拉中的全部类型选项（可见 .select-item 文本，含'标准资费'） */
async function listTypeOptions(w) {
  return w.page.evaluate(() => {
    const labels = [...document.querySelectorAll('.select-label')]
    const lb = labels.find((el) => (el.innerText || '').trim().replace(/[:：]/, '') === '资费类型')
    let root = null
    if (lb) {
      const box = lb.parentElement?.querySelector('.select-box')
      root = box ? box.closest('.select-container') || lb.parentElement : lb.parentElement
    }
    if (!root) {
      const sb = document.querySelector('.select-box')
      root = sb ? sb.closest('.select-container') || sb.parentElement : null
    }
    if (!root) return []
    return [...root.querySelectorAll('.select-item')]
      .filter((e) => e.offsetParent !== null)
      .map((e) => (e.innerText || '').trim())
      .filter(Boolean)
  })
}

/** 点击指定类型选项（需先 openTypeDropdown），返回 'ok' | 'nf' */
async function clickTypeOption(w, label) {
  return w.page.evaluate(
    (t) => {
      const labels = [...document.querySelectorAll('.select-label')]
      const lb = labels.find((el) => (el.innerText || '').trim().replace(/[:：]/, '') === '资费类型')
      let root = null
      if (lb) {
        const box = lb.parentElement?.querySelector('.select-box')
        root = box ? box.closest('.select-container') || lb.parentElement : lb.parentElement
      }
      if (!root) {
        const sb = document.querySelector('.select-box')
        root = sb ? sb.closest('.select-container') || sb.parentElement : null
      }
      if (!root) return 'nf'
      const items = [...root.querySelectorAll('.select-item')].filter((e) => e.offsetParent !== null)
      const hit = items.find((e) => (e.innerText || '').trim() === t)
      if (hit) {
        hit.click()
        return 'ok'
      }
      return 'nf'
    },
    label
  )
}

/* ---------- 标准资费（StandarTariff 表格视图） ---------- */

/** 从拦截到的 getStandardlist 响应构造卡片（tHead/tBody 两种键名形态通吃） */
function standardItemsFromApi(json) {
  const body = json?.rspBody
  const tt = Array.isArray(body)
    ? body?.[0]?.tariffTable ?? null
    : body?.tariffList?.[0]?.tariffTable ?? null
  if (!tt || !Array.isArray(tt.tHead) || !Array.isArray(tt.tBody)) return null
  const heads = tt.tHead.filter(Boolean)
  const keys = heads.map((h) => Object.keys(h)[0])
  const titles = heads.map((h, i) => (keys[i] != null ? String(h[keys[i]]) : `列${i + 1}`))
  const items = []
  for (const row of tt.tBody) {
    if (!row) continue
    const fields = {}
    titles.forEach((t, i) => {
      const v = row[keys[i]] ?? row[`field${i + 1}`] ?? ''
      if (String(v ?? '').trim() !== '') fields[t] = String(v).trim()
    })
    if (Object.keys(fields).length === 0) continue
    fields['资费类型'] = '标准资费'
    const name =
      fields['资费名称'] ||
      fields['业务名称'] ||
      fields['项目'] ||
      fields['业务'] ||
      fields['服务名称'] ||
      Object.values(fields)[0] ||
      '未命名标准资费'
    items.push({ name, fields, usage: [], gray: {} })
  }
  return items.length ? items : null
}

/** DOM 兜底：从 vxe-table 渲染结果提取标准资费行（仅在 API 拦截缺失时使用） */
async function standardItemsFromDom(w) {
  return w.page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.free-cont-box')]
    const items = []
    for (const b of boxes) {
      const trs = [...b.querySelectorAll('.vxe-table--main-wrapper tbody tr')]
      const ths = [...b.querySelectorAll('.vxe-table--main-wrapper thead th')].map(
        (th) => (th.innerText || '').trim()
      )
      for (const tr of trs) {
        const cells = [...tr.querySelectorAll('td')].map((td) => (td.innerText || '').trim())
        if (!cells.some(Boolean)) continue
        const fields = {}
        cells.forEach((c, i) => {
          if (c) fields[ths[i] || `列${i + 1}`] = c
        })
        fields['资费类型'] = '标准资费'
        items.push({
          name: fields['资费名称'] || cells.find(Boolean) || '未命名标准资费',
          fields,
          usage: [],
          gray: {},
        })
      }
    }
    return items
  })
}

/* ---------- 采集主流程 ---------- */

async function saveJson(w, cards, filename) {
  const path = join(OUT_DIR, filename)
  writeFileSync(path, JSON.stringify(cards, null, 1), 'utf-8')
  w.log(`saved: ${path} (${cards.length} cards)`)
}

/**
 * 唯一阶段：个人资费 / 河北资费 × 全部类型（动态枚举 + 接口齐全性校验）
 */
async function phasePersonalHebei(w) {
  w.log('=== PHASE: 个人资费/河北资费 × 全部类型 ===')
  await resetToHebei(w)
  await w.page.evaluate(() => document.querySelectorAll('.range-tab')[1]?.click())
  await w.jitter(10, 16)
  await waitIdle(w)

  // 标准资费选项依赖选省后 getStandardlist 响应到位（isShowStandard=true 才会附加到下拉）：
  // 先等响应（最多 ~50s，WARP 慢出口兜底），再枚举下拉（带 3 次重试）
  if (!w.api.standard) {
    w.log('等待 getStandardlist 响应（标准资费选项的附加条件）...')
    for (let i = 0; i < 12 && !w.api.standard; i++) {
      await w.jitter(2.5, 4)
    }
    w.log(`getStandardlist: ${w.api.standard ? '已捕获' : '未见（该省可能无标准资费或响应超时）'}`)
  }
  let options = []
  for (let i = 0; i < 3; i++) {
    await openTypeDropdown(w)
    options = await listTypeOptions(w)
    if (options.length > 0 && options.includes('标准资费')) break
    // 收起下拉（再点一次 box）后稍等重试
    await w.page.evaluate(() => {
      const sb = document.querySelector('.select-box')
      sb?.click()
    })
    await w.jitter(4, 8)
  }
  if (options.length === 0) throw new Error('类型下拉枚举失败（页面结构可能已变化）')
  w.log(`类型下拉选项（${options.length} 个）: ${options.join(' / ')}`)

  if (SMOKE) {
    // 冒烟：验证选项枚举 + 切一个非默认类型 + 卡片选择器 + 接口拦截
    const probe = options.find((o) => o !== '套餐' && o !== '标准资费') || options[0]
    await clickTypeOption(w, probe)
    await w.jitter(8, 14)
    await waitIdle(w)
    await scrollAll(w, 3)
    const n = await countCards(w)
    if (probe !== '标准资费' && n === 0 && w.api.standard == null) {
      throw new Error('SMOKE 未观察到卡片与标准资费数据（选择器或页面结构可能已变化）')
    }
    const apiSnapshot = [...w.api.lists.entries()].map(
      ([k, v]) => `${k} → total=${v.total} beans=${v.beans}`
    )
    w.log(`SMOKE 探测类型「${probe}」: ${n} cards；API 拦截: ${apiSnapshot.join(' ; ') || '（暂无）'}`)
    w.log(`SMOKE 标准资费数据: ${w.api.standard ? '已捕获' : '未见（该省可能无标准资费或尚未返回）'}`)
    return 'smoke-ok'
  }

  /* 全量：逐类型采集（保持下拉顺序，跳过重复） */
  const results = []
  const done = new Set()
  for (const label of options) {
    if (done.has(label)) continue
    done.add(label)

    if (label === '标准资费') {
      // 标准资费：点选触发 StandarTariff 表格视图；数据优先取拦截到的 API 原始响应
      await openTypeDropdown(w)
      const res = await clickTypeOption(w, label)
      await w.jitter(8, 14)
      if (res === 'nf') {
        w.log(`标准资费: 下拉选项消失（数据可能为空），跳过`)
        results.push({ label, count: 0, apiTotal: 0, note: '选项不可用' })
        continue
      }
      let items = standardItemsFromApi(w.api.standard)
      if (!items) {
        items = await standardItemsFromDom(w)
        w.log(`标准资费: API 拦截缺失，DOM 兜底提取 ${items.length} 行`)
      }
      if (items && items.length) {
        await saveJson(w, items, `p_h_${fileSafe(label)}.json`)
        results.push({ label, count: items.length, apiTotal: items.length, note: '接口原始数据' })
      } else {
        w.log(`标准资费: 无数据行`)
        results.push({ label, count: 0, apiTotal: 0, note: '无数据行' })
      }
      continue
    }

    // 常规类型：下拉点选 → 等列表加载 → 真人滚动收集
    await openTypeDropdown(w)
    const res = await clickTypeOption(w, label)
    await w.jitter(8, 14)
    await waitIdle(w)
    if (res === 'nf') {
      w.log(`${label}: 下拉选项消失，跳过`)
      results.push({ label, count: 0, apiTotal: null, note: '选项不可用' })
      continue
    }
    let count = await scrollAll(w)
    if (count === 0) {
      // 列表级自愈：0 cards（限流/慢批次）——冷却 60~90s 后重选类型重抓一次
      w.log(`${label}: 0 cards——冷却后重试一次`)
      await w.jitter(60, 90)
      await openTypeDropdown(w)
      const r2 = await clickTypeOption(w, label)
      await w.jitter(10, 16)
      await waitIdle(w)
      if (r2 === 'ok') count = await scrollAll(w)
    }
    // 接口齐全性自愈：DOM 数 < 接口声明 total → 重滚一轮（在途批次兜底）
    const type2 = TYPE_VALUE[label]
    const entry = type2 ? w.api.lists.get(`${SCOPE_KEY}${type2}`) : null
    const apiTotal = entry ? entry.total : null
    if (apiTotal != null && count < apiTotal) {
      w.log(`${label}: DOM ${count} < 接口 total ${apiTotal}——追加一轮滚动自愈`)
      count = await scrollAll(w)
    }
    w.log(`${label}: ${count} cards（接口 total=${apiTotal ?? '未知'}）`)
    const cards = count > 0 ? await extractCards(w) : null
    if (cards) {
      for (const c of cards) c._sourceType = label
      await saveJson(w, cards, `p_h_${fileSafe(label)}.json`)
    }
    results.push({ label, count, apiTotal, note: '' })
    await w.jitter(3, 6) // 类型之间的浏览间歇
  }

  /* ---------- 逆向接口齐全性报告（不齐全即失败，阻断推送） ---------- */
  const report = {
    fetchedAt: new Date().toISOString(),
    scope: '个人 × 河北分省',
    types: results,
    apiLists: [...w.api.lists.entries()].map(([k, v]) => ({ key: k, ...v })),
    standardFromApi: !!w.api.standard,
    typesListFromApi: w.api.typesList ? 'captured' : 'not-seen',
  }
  writeFileSync(join(API_DUMP_DIR, 'api-report.json'), JSON.stringify(report, null, 2), 'utf-8')
  if (w.api.standard) {
    writeFileSync(join(API_DUMP_DIR, 'standard-raw.json'), JSON.stringify(w.api.standard, null, 2), 'utf-8')
  }

  tlog('── 逆向接口齐全性报告 ──')
  let incomplete = 0
  for (const r of results) {
    const flag =
      r.apiTotal == null
        ? '⚠ 未核对'
        : r.count >= r.apiTotal
          ? '✓ 完整'
          : `✗ 缺失 ${r.apiTotal - r.count} 条`
    if (r.apiTotal != null && r.count < r.apiTotal) incomplete++
    tlog(`  ${r.label}: 抓取 ${r.count} / 接口 ${r.apiTotal ?? '—'} ${flag}${r.note ? `（${r.note}）` : ''}`)
  }
  if (incomplete > 0) {
    tlog(`=== FAILED：${incomplete} 个类型抓取数低于接口声明总数（宁缺毋滥，阻断当日推送）===`)
    process.exitCode = 1
    return
  }
  // 至少要有数据（全空大概率页面改版）
  const totalCards = results.reduce((s, r) => s + r.count, 0)
  if (totalCards === 0) {
    tlog('=== FAILED：全部类型 0 卡片（页面结构可能已变化）===')
    process.exitCode = 1
    return
  }
  tlog(`齐全性校验通过：${results.length} 个类型合计 ${totalCards} 条`)
}

const TASKS = [{ label: '个人×河北全类型', run: phasePersonalHebei }]

tlog(
  `启动：模式=${SMOKE ? 'SMOKE（快速冒烟·单 worker）' : 'FULL（个人×河北 × 全部类型）'}，` +
    `任务=${TASKS.map((t) => t.label).join(' / ')}` +
    (process.env.WARP_SOCKS ? `，代理=${process.env.WARP_SOCKS}` : '，出口=TUN 直连')
)

/* ---------- worker pool（当前单阶段=单 worker） ---------- */
let nextTask = 0
const settled = await Promise.allSettled([
  (async () => {
    const w = await createWorker(1)
    try {
      while (true) {
        const idx = nextTask++
        if (idx >= TASKS.length) break
        const task = TASKS[idx]
        w.log(`领取任务: ${task.label}`)
        if (idx > 0) await w.jitter(8, 15)
        const r = await task.run(w)
        if (SMOKE && r === 'smoke-ok') {
          w.log('SMOKE 通过 ✓ 导航 + 河北选择 + 页签切换 + 类型下拉枚举 + 滚动 + 接口拦截全部健康')
          await w.context.close()
          return 'smoke-ok'
        }
        await w.jitter(6, 12)
      }
      await w.context.close()
    } catch (e) {
      await w.context.close().catch(() => {})
      throw e
    }
  })(),
])

await browser.close()

const failures = settled.filter((s) => s.status === 'rejected')
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`[worker 失败] ${f.reason && f.reason.message ? f.reason.message : f.reason}`)
  }
  tlog(`=== FAILED（worker 异常退出）===`)
  process.exit(1)
}

if (process.exitCode) process.exit(process.exitCode)
tlog(`=== ALL DONE（总耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）===`)
