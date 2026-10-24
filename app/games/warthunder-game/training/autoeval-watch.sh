#!/bin/bash
# autoeval-watch.sh — 快评守望（2026-10-18 防漂移三板斧之三）：训练照跑，每 20 万步
# 自动拷 checkpoint 快评 3 局（1 窗，与 farm 并行——数字偏慢但趋势可比），记录趋势；
# 连续 2 次均值 > 250s 自动止损（杀 farm+服务器，checkpoint 已在盘上，人工定夺回滚点）。
# 用法：bash training/autoeval-watch.sh [检查间隔步数=200000] [止损线秒=250]
#       （须在 farm/服务器已启动后另开终端运行；Ctrl-C 退出不影响训练）
cd "$(dirname "$0")/.."
EVERY=${1:-200000}
LIMIT=${2:-250}
LAST_CHECK=0; BAD=0; ROUND=0
echo "[autoeval] 守望启动：每 ${EVERY} 步快评一次，连续 2 次 >${LIMIT}s 止损"
while true; do
  sleep 60
  pgrep -f "ppo7_train" >/dev/null || { echo "[autoeval] 训练服务器已停，守望退出"; break; }
  STEPS=$(curl -s --max-time 3 http://127.0.0.1:8771/stats | python3 -c "import json,sys;print(json.load(sys.stdin).get('steps_total',0))" 2>/dev/null) || continue
  [ -z "$STEPS" ] && continue
  NODE=$((STEPS / EVERY))
  if [ "$NODE" -gt "$LAST_CHECK" ]; then
    LAST_CHECK=$NODE; ROUND=$((ROUND+1))
    GEN=$(python3 -c "import json;print(json.load(open('training/ppo7-weights-latest.json'))['gen'])" 2>/dev/null)
    cp training/ppo7-weights-latest.json training/autoeval-weights.json   # 专用评测权重——绝不碰玩家版 rl7-weights.json（10-24 事故：曾覆盖玩家版）
    rm -rf /tmp/wt-eval-rl7   # 坏缓存会致评测窗静默启动失败（10-18 实测），每轮清
    echo "[autoeval] 第${ROUND}轮快评 @ ${STEPS} 步 (gen${GEN})…"
    EVALW=training/autoeval-weights.json ../../node_modules/.bin/electron training/eval-rl7.cjs 3 1 8123 2>/dev/null | grep "局#" > /tmp/autoeval-r${ROUND}.log
    AVG=$(grep -o 't=[0-9]*s' /tmp/autoeval-r${ROUND}.log | grep -o '[0-9]*' | awk '{s+=$1;n++}END{if(n)printf "%.0f",s/n;else print 9999}')
    echo "[autoeval] 第${ROUND}轮 @gen${GEN}：均值 ${AVG}s（明细：$(grep -o 't=[0-9]*s' /tmp/autoeval-r${ROUND}.log | tr '\n' ' ')）"
    if [ "$AVG" -ge 9999 ]; then
      echo "[autoeval] ⚠️ 本轮无有效局（评测窗异常），不计超线"
    elif [ "$AVG" -gt "$LIMIT" ]; then
      BAD=$((BAD+1))
      echo "[autoeval] ⚠️ 超线 ${BAD}/2"
      if [ "$BAD" -ge 2 ]; then
        echo "[autoeval] 🛑 连续 2 次超线——止损！杀 farm+服务器（checkpoint 已在盘，人工定夺回滚）"
        pkill -f "farm-rl7"; pkill -f "ppo7_train"
        echo "[autoeval] 已止损。最近两轮成绩见 /tmp/autoeval-r*.log"
        break
      fi
    else
      BAD=0
    fi
  fi
done
