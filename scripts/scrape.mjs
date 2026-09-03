/**
 * 中国移动河北资费公示抓取 —— GitHub Actions / 本地通用版（Playwright · 并行 worker pool）
 * 运行: node scripts/scrape.mjs   （需先: npm i playwright && npx playwright install --with-deps chromium）
 * 并行: SCRAPE_CONCURRENCY=2 node scripts/scrape.mjs（默认 2，可 1~4）
 * 冒烟: SCRAPE_SMOKE=1 node scripts/scrape.mjs  （单 worker 验证导航+选择器健康，约 1 分钟，不落盘）
 *
 * 网络出口：GitHub Actions 中由 workflow 先连接 Cloudflare WARP（warp-cli connect 隧道接管全机流量），
 *           Chromium 的全部请求自然经 WARP 出口，避免数据中心 IP 直接访问公示页被风控。
 *           若 runner 网络限制 TUN 隧道，workflow 会自动降级 SOCKS 代理模式并注入 WARP_SOCKS 环境变量，
 *           本脚本读取该变量让 Chromium 走 socks5 代理（效果等价，推送 API 走直连）。
 *
 * 并行模型（多"虚拟用户"同时浏览）：
 *   4 个采集阶段（个人/全网 · 个人/河北 · 政企/全网 · 政企/河北）为独立工作单元，
 *   worker pool 并行认领执行——每个 worker 拥有独立 browser context：
 *   独立 cookie/localStorage、独立微随机视口、独立随机节奏序列（= 同一 WARP 出口 IP 后的多个真实用户，
 *   CGNAT 共享出口下多会话本属常态）。worker 内部保持完整真人节奏串行遍历。
 *   并发 2 时全量约 10~15 分钟（串行版 20~30 分钟）。
 *
 * 真人节奏（防风控核心，处处随机不可预测；每个 worker 各自独立）：
 *   1. 所有等待均带随机抖动 jitter(min,max)——没有两次运行的节奏相同；
 *   2. 滚动是「浏览式」而非「机器式」：每轮 1~3 小步滚动 + 轮末直跳绝对底部（懒加载触发器），
 *      步间 0.8~1.8s，轮间 2~5s，15% 概率 5~9s「阅读停留」；
 *   3. 切类型 8~13s、切页签 8~16s、换阶段 8~15s 大间隔随机；
 *   4. 视口尺寸每个 worker 独立微随机（宽 1346~1386 / 高 870~930）；
 *   5. 偶发鼠标轨迹漂移（mouseDrift），补充真实指针事件。
 *
 * 输出: seed/p_n_*.json / seed/p_h_all.json / seed/g_n_*.json / seed/g_h_all.json
 *   （每文件为 JSON 数组：[{name, fields, usage, gray}]，与 agent-browser 版结构一致，供 normalize.mjs 消费）
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = process.env.SCRAPE_OUT_DIR || join(__dirname, '..', 'seed')
const SMOKE = !!process.env.SCRAPE_SMOKE
const URL =
  'https://h.app.coc.10086.cn/cmcc-app/pc-pages/tariffZonePers.html?pageId=834148205904408576&prov=531'
// SCRAPE_ONLY=套餐,加装包 可只跑指定类型（调试用）；输出重定向用 SCRAPE_OUT_DIR
const TYPES = (process.env.SCRAPE_ONLY ? process.env.SCRAPE_ONLY.split(',') : ['套餐', '加装包', '营销活动', '港澳台/国际资费'])
// 并行 worker 数（SMOKE 固定单 worker；常规 1~4，默认 2）
const CONCURRENCY = SMOKE
  ? 1
  : Math.max(1, Math.min(4, parseInt(process.env.SCRAPE_CONCURRENCY || '2', 10)))

mkdirSync(OUT_DIR, { recursive: true })

/** 随机数工具：[min, max) 浮点 */
const rand = (min, max) => min + Math.random() * (max - min)

const startedAt = Date.now()
const tlog = (msg) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${msg}`)

const browser = await chromium.launch({
  headless: true,
  // WARP SOCKS 代理模式降级：workflow 注入 WARP_SOCKS 时 Chromium 走本地 socks5 代理
  // （context 自动继承 launch 级 proxy，每个 worker 无需重复配置）
  ...(process.env.WARP_SOCKS ? { proxy: { server: process.env.WARP_SOCKS } } : {}),
})

/**
 * 创建一个 worker（= 一个"虚拟用户"）：
 * 独立 browser context（独立 cookie/存储）、独立微随机视口、独立日志前缀与节奏序列。
 */
async function createWorker(id) {
  // 视口每个 worker 微随机（同为桌面画像，彼此指纹不同）
  const viewport = {
    width: Math.round(rand(1346, 1386)),
    height: Math.round(rand(870, 930)),
  }
  // UA 主版本微随机（126~128，真实世界大量并存）
  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.round(
    rand(126, 129)
  )}.0.0.0 Safari/537.36`
  const context = await browser.newContext({ userAgent: ua, viewport })
  const page = await context.newPage()
  page.setDefaultTimeout(30000)

  const w = {
    id,
    context,
    page,
    viewport,
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
 * 直到卡片数连续 8 轮无增长且已到达页面真实底部。
 *
 * 关键教训（生产实测）：懒加载以「到达/接近底部」为触发条件；纯小步平滑滚动
 * （smooth scrollBy 会被后续调用打断，实际位移远小于预期）可能始终到不了底部，
 * 且慢网络（WARP/跨境）下批次在途时停滞计数即成立 → 提前终止漏抓（首跑 781/3109）。
 * 故：① 每轮末尾直跳绝对底部确保触发；② 停滞阈值 8 轮 + 真底校验（不在底部则减半继续）。
 * @param maxRounds 最大滚动轮数（SMOKE 模式传小值快速验证）
 */
async function scrollAll(w, maxRounds = 120) {
  await waitIdle(w)
  const stallRounds = 8
  let stall = 0
  let last = 0
  for (let round = 0; round < maxRounds; round++) {
    const prev = await countCards(w)
    // 一轮 = 1~3 个小步（instant 位移，避免 smooth 被打断）模拟滑动读内容
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
    // 轮间停顿：常规 2~5s；15% 概率 5~9s「阅读停留」——给在途批次足够到达时间
    await (Math.random() < 0.15 ? w.jitter(5, 9) : w.jitter(2, 5))
    const now = await countCards(w)
    stall = prev === now ? stall + 1 : 0
    last = now
    if (stall >= stallRounds && now !== 0) {
      // 真底校验：视口确在底部才认定完成
      const atBottom = await w.page.evaluate(
        () => window.innerHeight + window.scrollY >= document.body.scrollHeight - 100
      )
      if (atBottom) {
        // 慢出口（WARP/跨境）在途批次兜底：到底后长停顿 6~12s 再数一次，
        // 有新增则计数清零继续（大列表类型实测 1318↔450 波动即此因——批次延迟超 stall 窗口被误判完成）
        await w.jitter(6, 12)
        const recheck = await countCards(w)
        if (recheck === now) break // 确认真无新增
        stall = 0
      } else {
        stall = Math.floor(stall / 2) // 不在底部 → 减半计数继续滚动
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
  await w.jitter(8, 14) // 打开页面先"看一看"
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

/** 提取当前页全部资费卡片（与 v2.sh 的 EXTRACT_JS 同构，选择器经生产数据验证） */
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

async function saveJson(w, cards, filename) {
  const path = join(OUT_DIR, filename)
  writeFileSync(path, JSON.stringify(cards, null, 1), 'utf-8')
  w.log(`saved: ${path} (${cards.length} cards)`)
}

/** 类型下拉选择（.select-box[0] → 可见 .select-item 中文本匹配的类型） */
async function selectType(w, type) {
  await mouseDrift(w)
  await w.page.evaluate(() => document.querySelectorAll('.select-box')[0]?.click())
  await w.jitter(1.2, 2.5)
  const res = await w.page.evaluate((t) => {
    const opts = [...document.querySelectorAll('.select-item')].filter((e) => e.offsetParent !== null)
    const hit = opts.find((e) => (e.innerText || '').trim() === t)
    if (hit) {
      hit.click()
      return 'ok'
    }
    return 'nf'
  }, type)
  await w.jitter(8, 13) // 切类型后列表整页重新加载，慢慢等
  await waitIdle(w)
  return res
}

const fileSafe = (type) => type.replace(/\//g, '_').replace(/资费/g, '')

/* ---------- 4 个采集阶段（独立工作单元，可被任意 worker 认领） ---------- */

/** 阶段 1：个人资费 / 全网资费 × 各类型 */
async function phasePersonalNational(w) {
  w.log('=== PHASE: 个人资费/全网资费 各类型 ===')
  await resetToHebei(w)
  for (const type of TYPES) {
    const res = await selectType(w, type)
    if (res === 'nf') {
      w.log(`personal/national/${type}: 类型不存在，跳过`)
      continue
    }
    let count = await scrollAll(w, SMOKE ? 3 : 120)
    if (!SMOKE && count === 0) {
      // 类型级自愈：0 cards（限流/慢批次）——冷却 60~90s 后重选类型重抓一次
      w.log(`personal/national/${type}: 0 cards——冷却后重试一次`)
      await w.jitter(60, 90)
      await selectType(w, type)
      count = await scrollAll(w, 120)
    }
    w.log(`personal/national/${type}: ${count} cards`)
    const cards = count > 0 ? await extractCards(w) : null
    if (SMOKE && cards) {
      // 冒烟只验证健康，不落盘（避免覆盖 seed/ 下的全量数据）
      w.log(`SMOKE 样本（${cards.length} cards）: ${cards.slice(0, 3).map((c) => c.name).join(' / ')}`)
      return 'smoke-ok'
    }
    if (cards) await saveJson(w, cards, `p_n_${fileSafe(type)}.json`)
    await w.jitter(3, 6) // 类型之间的浏览间歇
  }
}

/** 阶段 2：个人资费 / 河北资费（全部类型） */
async function phasePersonalHebei(w) {
  w.log('=== PHASE: 个人资费/河北资费 ===')
  await resetToHebei(w)
  await w.page.evaluate(() => document.querySelectorAll('.range-tab')[1]?.click())
  await w.jitter(10, 16)
  await waitIdle(w)
  let count = await scrollAll(w)
  if (count === 0) {
    w.log('personal/hebei/all: 0 cards——冷却后重试一次')
    await w.jitter(60, 90)
    await w.page.evaluate(() => document.querySelectorAll('.range-tab')[1]?.click())
    await w.jitter(10, 16)
    await waitIdle(w)
    count = await scrollAll(w)
  }
  w.log(`personal/hebei/all: ${count} cards`)
  if (count > 0) await saveJson(w, await extractCards(w), 'p_h_all.json')
}

/** 阶段 3：政企资费 / 全网资费 × 各类型 */
async function phaseGovNational(w) {
  w.log('=== PHASE: 政企资费/全网资费 各类型 ===')
  await resetToHebei(w)
  await w.page.evaluate(() => document.querySelectorAll('.tab-item')[1]?.click())
  await w.jitter(8, 14)
  await waitIdle(w)
  for (const type of TYPES) {
    const res = await selectType(w, type)
    if (res === 'nf') {
      w.log(`gov/national/${type}: 类型不存在，跳过`)
      continue
    }
    let count = await scrollAll(w)
    if (count === 0) {
      w.log(`gov/national/${type}: 0 cards——冷却后重试一次`)
      await w.jitter(60, 90)
      await selectType(w, type)
      count = await scrollAll(w)
    }
    w.log(`gov/national/${type}: ${count} cards`)
    if (count > 0) await saveJson(w, await extractCards(w), `g_n_${fileSafe(type)}.json`)
    await w.jitter(3, 6)
  }
}

/** 阶段 4：政企资费 / 河北资费（全部类型） */
async function phaseGovHebei(w) {
  w.log('=== PHASE: 政企资费/河北资费 ===')
  await resetToHebei(w)
  await w.page.evaluate(() => document.querySelectorAll('.tab-item')[1]?.click())
  await w.jitter(8, 14)
  await waitIdle(w)
  await w.page.evaluate(() => document.querySelectorAll('.range-tab')[1]?.click())
  await w.jitter(10, 16)
  await waitIdle(w)
  let count = await scrollAll(w)
  if (count === 0) {
    w.log('gov/hebei/all: 0 cards——冷却后重试一次')
    await w.jitter(60, 90)
    await w.page.evaluate(() => document.querySelectorAll('.range-tab')[1]?.click())
    await w.jitter(10, 16)
    await waitIdle(w)
    count = await scrollAll(w)
  }
  w.log(`gov/hebei/all: ${count} cards`)
  if (count > 0) await saveJson(w, await extractCards(w), 'g_h_all.json')
}

const TASKS = [
  { label: '个人×全网', run: phasePersonalNational },
  { label: '个人×河北', run: phasePersonalHebei },
  { label: '政企×全网', run: phaseGovNational },
  { label: '政企×河北', run: phaseGovHebei },
]

tlog(
  `启动：模式=${SMOKE ? 'SMOKE（快速冒烟·单 worker）' : `FULL（全量抓取·${CONCURRENCY} 并行 worker）`}，` +
    `任务=${TASKS.map((t) => t.label).join(' / ')}` +
    (process.env.WARP_SOCKS ? `，代理=${process.env.WARP_SOCKS}` : '，出口=TUN 直连')
)

/* ---------- worker pool：N 个"虚拟用户"并行认领 4 个阶段（SMOKE 只跑首个阶段的首个类型） ---------- */
let nextTask = 0
const settled = await Promise.allSettled(
  Array.from({ length: CONCURRENCY }, (_, i) =>
    (async () => {
      const w = await createWorker(i + 1)
      try {
        while (true) {
          const idx = nextTask++
          if (SMOKE && idx > 0) break // 冒烟只验证第一个阶段
          if (idx >= TASKS.length) break
          const task = TASKS[idx]
          w.log(`领取任务: ${task.label}`)
          if (idx > 0) await w.jitter(8, 15) // 阶段间大间隔（首个任务无需）
          const r = await task.run(w)
          if (SMOKE && r === 'smoke-ok') {
            w.log('SMOKE 通过 ✓ 导航 + 河北选择 + 类型切换 + 滚动 + 卡片选择器全部健康')
            await w.context.close()
            return 'smoke-ok'
          }
          await w.jitter(6, 12) // 任务完成后的浏览间歇
        }
        await w.context.close()
      } catch (e) {
        await w.context.close().catch(() => {})
        throw e
      }
    })()
  )
)

await browser.close()

const failures = settled.filter((s) => s.status === 'rejected')
if (failures.length > 0) {
  for (const f of failures) {
    console.error(`[worker 失败] ${f.reason && f.reason.message ? f.reason.message : f.reason}`)
  }
  tlog(`=== FAILED（${failures.length}/${CONCURRENCY} 个 worker 失败）===`)
  process.exit(1)
}

tlog(`=== ALL DONE（总耗时 ${Math.round((Date.now() - startedAt) / 1000)}s）===`)
