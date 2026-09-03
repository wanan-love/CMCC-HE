#!/bin/bash
# 中国移动资费公示页抓取脚本（河北）
# 遍历: 个人/政企 × 全网/河北 × 4种资费类型，滚动加载全部卡片后提取
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
    // 套餐内容 table
    const rows = [...c.querySelectorAll(".table-area tr, .table-area .table-row")];
    let usage = [];
    if (rows.length) {
      for (const r of rows) {
        const cells = [...r.querySelectorAll("td, th, .row-title, .tips-content")].map(x => (x.innerText||"").trim()).filter(Boolean);
        if (cells.length >= 2) usage.push({ label: cells[0], value: cells.slice(1).join(" / ") });
      }
    } else {
      const ta = c.querySelector(".table-area");
      if (ta) {
        const parts = (ta.innerText || "").trim().split(/\n+/).filter(Boolean);
        for (let i = 0; i + 1 < parts.length; i += 2) usage.push({ label: parts[i], value: parts[i+1] });
      }
    }
    // 灰色区域（超出资费说明等）
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

scroll_all() {
  local stall=0
  for i in $(seq 1 30); do
    local prev=$(agent-browser eval 'document.querySelectorAll(".tariff-item-container").length' 2>/dev/null | tr -d '"')
    agent-browser eval 'window.scrollTo(0, document.body.scrollHeight)' > /dev/null 2>&1
    sleep 2
    local now=$(agent-browser eval 'document.querySelectorAll(".tariff-item-container").length' 2>/dev/null | tr -d '"')
    if [ "$prev" = "$now" ]; then stall=$((stall+1)); else stall=0; fi
    if [ "$stall" -ge 3 ]; then break; fi
  done
  agent-browser eval 'window.scrollTo(0, 0)' > /dev/null 2>&1
}

click_tab() { # $1 = index
  agent-browser eval "(() => { document.querySelectorAll('.tab-item')[$1]?.click(); return 'ok'; })()" > /dev/null 2>&1
  sleep 3
}

click_range() { # $1 = index
  agent-browser eval "(() => { document.querySelectorAll('.range-tab')[$1]?.click(); return 'ok'; })()" > /dev/null 2>&1
  sleep 3
}

select_type() { # $1 = type name
  agent-browser eval "(() => { document.querySelectorAll('.select-box')[0]?.click(); return 'ok'; })()" > /dev/null 2>&1
  sleep 1
  agent-browser eval "(() => { const opts=[...document.querySelectorAll('.select-item')].filter(e=>e.offsetParent!==null); const t=opts.find(e=>(e.innerText||'').trim()==='$1'); if(t){t.click(); return 'selected $1';} return 'not-found:'+opts.map(o=>o.innerText.trim()).join(','); })()" 2>&1 | tail -1
  sleep 4
}

for TAB_IDX in 0 1; do
  TAB_NAME=$([ $TAB_IDX = 0 ] && echo "personal" || echo "gov")
  click_tab $TAB_IDX
  for RANGE_IDX in 0 1; do
    RANGE_NAME=$([ $RANGE_IDX = 0 ] && echo "national" || echo "hebei")
    click_range $RANGE_IDX
    for TYPE in "套餐" "加装包" "营销活动" "港澳台/国际资费"; do
      TYPE_NAME=$(echo "$TYPE" | tr '/' '_' | sed 's/资费//')
      echo ">>> 抓取: $TAB_NAME / $RANGE_NAME / $TYPE"
      RES=$(select_type "$TYPE")
      echo "    select: $RES"
      scroll_all
      COUNT=$(agent-browser eval 'document.querySelectorAll(".tariff-item-container").length' 2>/dev/null | tr -d '"')
      echo "    cards: $COUNT"
      if [ "$COUNT" != "0" ] && [ -n "$COUNT" ]; then
        agent-browser eval "$EXTRACT_JS" --json > "$OUTDIR/${TAB_NAME}_${RANGE_NAME}_${TYPE_NAME}.json" 2>/dev/null
        SIZE=$(wc -c < "$OUTDIR/${TAB_NAME}_${RANGE_NAME}_${TYPE_NAME}.json")
        echo "    saved: $SIZE bytes"
      fi
    done
  done
done

echo "=== DONE ==="
ls -la "$OUTDIR"
