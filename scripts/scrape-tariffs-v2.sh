#!/bin/bash
# 中国移动资费公示抓取 - 健壮版 v2
# 策略: 每个大阶段 reload 重置状态，重新选择河北，避免Vue状态错乱
set -u
OUTDIR="/home/z/my-project/seed"
mkdir -p "$OUTDIR"

EXTRACT_JS='
(() => {
  const cards = [...document.querySelectorAll(".tariff-item-container")];
  const out = [];
  for (const c of cards) {
    const name = c.querySelector(".item-name")?.innerText?.trim() || "";
    const tips = [...c.querySelectorAll(".item-tips-list .tips-attr, .item-tips-list .tips-content")];
    const fields = {};
    let lastLabel = null;
    for (const el of tips) {
      const txt = (el.innerText || "").trim();
      if (el.classList.contains("tips-attr")) {
        lastLabel = txt.replace(/[:：]\s*$/, "");
      } else if (lastLabel) {
        fields[lastLabel] = txt;
        lastLabel = null;
      }
    }
    const ta = c.querySelector(".table-area");
    let usage = [];
    if (ta) {
      const parts = (ta.innerText || "").trim().split(/\n+/).filter(Boolean);
      for (let i = 0; i + 1 < parts.length; i += 2) usage.push({ label: parts[i], value: parts[i+1] });
    }
    const gray = {};
    const grayText = c.querySelector(".list-gray")?.innerText || "";
    const labels = ["超出资费说明", "其他服务内容", "其他说明", "备注", "温馨提示"];
    for (const lb of labels) {
      const re = new RegExp(lb + "[:：]\\s*");
      const m = grayText.match(re);
      if (m) {
        const start = m.index + m[0].length;
        let end = grayText.length;
        for (const lb2 of labels) {
          if (lb2 === lb) continue;
          const re2 = new RegExp(lb2 + "[:：]");
          const m2 = grayText.slice(start).match(re2);
          if (m2) end = Math.min(end, start + m2.index);
        }
        gray[lb] = grayText.slice(start, end).trim();
      }
    }
    out.push({ name, fields, usage, gray });
  }
  return JSON.stringify(out);
})()
'

ab() { agent-browser eval "$1" 2>/dev/null | tr -d '"' | tail -1; }

wait_idle() { # 等待加载指示消失
  for i in $(seq 1 15); do
    local loading=$(ab "(() => { const t=document.body.innerText; return t.includes(\"努力加载中\") ? \"1\" : \"0\"; })()")
    [ "$loading" = "0" ] && break
    sleep 2
  done
  sleep 2
}

scroll_all() {
  wait_idle
  local stall=0 last=0
  for i in $(seq 1 40); do
    local prev=$(ab 'document.querySelectorAll(".tariff-item-container").length')
    agent-browser eval 'window.scrollTo(0, document.body.scrollHeight)' > /dev/null 2>&1
    sleep 2.5
    local now=$(ab 'document.querySelectorAll(".tariff-item-container").length')
    if [ "$prev" = "$now" ]; then stall=$((stall+1)); else stall=0; fi
    last=$now
    if [ "$stall" -ge 4 ] && [ "$now" != "0" ]; then break; fi
  done
  ab 'window.scrollTo(0, 0)' > /dev/null
  echo "$last"
}

reset_to_hebei() { # reload + 选河北 + 等待
  agent-browser reload > /dev/null 2>&1
  sleep 10
  ab "(() => { document.querySelector('.prov-entry')?.click(); return 'ok'; })()" > /dev/null
  sleep 2
  ab "(() => { const items=[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&(e.innerText||'').trim()==='河北省'); items.forEach(e=>e.click()); return 'ok'; })()" > /dev/null
  sleep 8
  wait_idle
}

save_json() { # $1 = filename
  agent-browser eval "$EXTRACT_JS" --json > "$OUTDIR/$1" 2>/dev/null
  echo "    saved: $(wc -c < "$OUTDIR/$1") bytes"
}

# ============ PHASE 1: 个人资费 / 全网资费 ============
echo "=== PHASE 1: 个人资费/全网资费 各类型 ==="
reset_to_hebei
for TYPE in "套餐" "加装包" "营销活动" "港澳台/国际资费"; do
  TYPE_NAME=$(echo "$TYPE" | tr '/' '_' | sed 's/资费//')
  ab "(() => { document.querySelectorAll('.select-box')[0]?.click(); return 'ok'; })()" > /dev/null
  sleep 1.5
  ab "(() => { const opts=[...document.querySelectorAll('.select-item')].filter(e=>e.offsetParent!==null); const t=opts.find(e=>(e.innerText||'').trim()==='$TYPE'); if(t){t.click(); return 'ok';} return 'nf'; })()" > /dev/null
  sleep 10
  wait_idle
  COUNT=$(scroll_all)
  echo ">>> personal/national/$TYPE: $COUNT cards"
  if [ "$COUNT" != "0" ] && [ -n "$COUNT" ]; then
    save_json "p_n_${TYPE_NAME}.json"
  fi
done

# ============ PHASE 2: 个人资费 / 河北资费 ============
echo "=== PHASE 2: 个人资费/河北资费 ==="
reset_to_hebei
ab "(() => { document.querySelectorAll('.range-tab')[1]?.click(); return 'ok'; })()" > /dev/null
sleep 12
wait_idle
COUNT=$(scroll_all)
echo ">>> personal/hebei/all: $COUNT cards"
if [ "$COUNT" != "0" ] && [ -n "$COUNT" ]; then
  save_json "p_h_all.json"
fi

# ============ PHASE 3: 政企资费 / 全网资费 ============
echo "=== PHASE 3: 政企资费/全网资费 各类型 ==="
reset_to_hebei
ab "(() => { document.querySelectorAll('.tab-item')[1]?.click(); return 'ok'; })()" > /dev/null
sleep 10
wait_idle
for TYPE in "套餐" "加装包" "营销活动" "港澳台/国际资费"; do
  TYPE_NAME=$(echo "$TYPE" | tr '/' '_' | sed 's/资费//')
  ab "(() => { document.querySelectorAll('.select-box')[0]?.click(); return 'ok'; })()" > /dev/null
  sleep 1.5
  RES=$(ab "(() => { const opts=[...document.querySelectorAll('.select-item')].filter(e=>e.offsetParent!==null); const t=opts.find(e=>(e.innerText||'').trim()==='$TYPE'); if(t){t.click(); return 'ok';} return 'nf'; })()")
  if [ "$RES" = "nf" ]; then
    echo ">>> gov/national/$TYPE: 类型不存在，跳过"
    continue
  fi
  sleep 10
  wait_idle
  COUNT=$(scroll_all)
  echo ">>> gov/national/$TYPE: $COUNT cards"
  if [ "$COUNT" != "0" ] && [ -n "$COUNT" ]; then
    save_json "g_n_${TYPE_NAME}.json"
  fi
done

# ============ PHASE 4: 政企资费 / 河北资费 ============
echo "=== PHASE 4: 政企资费/河北资费 ==="
reset_to_hebei
ab "(() => { document.querySelectorAll('.tab-item')[1]?.click(); return 'ok'; })()" > /dev/null
sleep 10
wait_idle
ab "(() => { document.querySelectorAll('.range-tab')[1]?.click(); return 'ok'; })()" > /dev/null
sleep 12
wait_idle
COUNT=$(scroll_all)
echo ">>> gov/hebei/all: $COUNT cards"
if [ "$COUNT" != "0" ] && [ -n "$COUNT" ]; then
  save_json "g_h_all.json"
fi

echo "=== ALL DONE ==="
ls -la "$OUTDIR"
