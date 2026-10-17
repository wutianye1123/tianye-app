#!/bin/bash
# deploy.sh —— 天业游戏中心一键部署（GitHub + xiaotuling.com 服务器）
#
# 用法：
#   ./deploy.sh            # 增量同步游戏中心到服务器（只传有改动的文件，几秒完事）
#   ./deploy.sh --dmg      # 同上 + 上传 app/dist 里最新版 dmg 安装包（214MB，慢）
#   ./deploy.sh --push     # 同步前先 git push origin main
#
# 同步内容：
#   - app/launcher.html|launcher.css|web-api.js → 服务器 web 根 app/（及根部副本）
#   - app/games/**（增量：本地远端 md5 对比，只传差异；排除 training/node_modules）
#   - app/relay-server.js → /var/www/game-center/，有变化自动重启联机服务
#   - --dmg：app/dist/游戏中心-*-Mac.dmg 最新一个 → download/
# 验证：首页 / rooms API / 新版 GAME_VERSION / dmg 下载 各打一遍状态码。
#
# 已知边界：不做远端删除（本地删了的文件服务器会残留，需要时手动清）。

set -euo pipefail

HOST="root@81.70.199.45"
WEBROOT="/www/wwwroot/xiaotuling.com"
RELAYDIR="/var/www/game-center"
DMG=""

for arg in "$@"; do
  case "$arg" in
    --dmg) DMG=1 ;;
    --push) git push origin main ;;
  esac
done

cd "$(dirname "$0")"

echo "== 1/5 增量对比（本地 vs 服务器 md5）=="
# 本地清单：app 下三件套 + games 全部（排除训练数据等），统一 "md5  相对app/路径" 格式
LOCAL_LIST=$(mktemp); REMOTE_LIST=$(mktemp); DIFF_LIST=$(mktemp); trap 'rm -f "$LOCAL_LIST" "$REMOTE_LIST" "$DIFF_LIST"' EXIT
{ md5 -q app/launcher.html | awk '{print $1"  launcher.html"}'
  md5 -q app/launcher.css  | awk '{print $1"  launcher.css"}'
  md5 -q app/web-api.js    | awk '{print $1"  web-api.js"}'
  # macOS md5 多文件输出: MD5 (app/games/x) = hash（不带引号）→ 转 "hash  games/x"
  find app/games -type f ! -path "*/training/*" ! -path "*/node_modules/*" ! -name ".DS_Store" ! -path "*/__pycache__/*" ! -name "*.pyc" ! -name "._*" -print0 \
    | xargs -0 md5 | sed -E 's|^MD5 \(app/(.*)\) = ([a-f0-9]+)$|\2  \1|'
} | sort -k2 > "$LOCAL_LIST"

ssh "$HOST" "cd $WEBROOT/app && { md5sum launcher.html launcher.css web-api.js 2>/dev/null; find games -type f ! -path '*/training/*' ! -name '.DS_Store' ! -name '._*' -print0 | xargs -0 md5sum 2>/dev/null; }" | awk '{n=$1; $1=""; sub(/^ +/,""); print n"  "$0}' | sort -k2 > "$REMOTE_LIST"   # $0 而非 $1：文件名可含空格

# 差异 = 本地有而远端无 或 md5 不同；顺带报告远端独有文件（不删，仅提示）
join -j 2 -o 0,1.1,2.1 "$LOCAL_LIST" "$REMOTE_LIST" | awk '$2 != $3 {print $1}' > "$DIFF_LIST"
comm -23 <(cut -d' ' -f3- "$LOCAL_LIST" | sed 's/^ *//' | sort) <(awk '{n=$1;$1="";sub(/^ +/,"");print}' "$REMOTE_LIST" | sort) >> "$DIFF_LIST"
sort -u "$DIFF_LIST" -o "$DIFF_LIST"
ONLY_REMOTE=$(comm -13 <(cut -d' ' -f3- "$LOCAL_LIST" | sed 's/^ *//' | sort) <(awk '{n=$1;$1="";sub(/^ +/,"");print}' "$REMOTE_LIST" | sort) | head -5)
CHANGED=$(grep -c . "$DIFF_LIST" || true)
echo "   需上传: $CHANGED 个文件"
[ -n "$ONLY_REMOTE" ] && echo "   ⚠ 服务器独有(不自动删): $ONLY_REMOTE …"

echo "== 2/5 上传差异文件 =="
if [ "$CHANGED" -gt 0 ]; then
  tar -C app -cf - -T "$DIFF_LIST" | ssh "$HOST" "tar -xf - -C $WEBROOT/app --no-same-owner && find $WEBROOT/app -name '._*' -delete"
  # 根部三件套保持一致（web-api.js 供 /games/ 注入引用；launcher.html 是跳转页不动）
  ssh "$HOST" "cd $WEBROOT && cp app/web-api.js web-api.js && cp app/launcher.css launcher.css"
  echo "   已上传 $CHANGED 个"
else
  echo "   无差异，跳过"
fi

echo "== 3/5 联机服务 relay-server.js =="
LOCAL_RELAY=$(md5 -q app/relay-server.js)
REMOTE_RELAY=$(ssh "$HOST" "md5sum $RELAYDIR/relay-server.js" | awk '{print $1}')
if [ "$LOCAL_RELAY" = "$REMOTE_RELAY" ]; then
  echo "   无变化，跳过重启"
else
  scp -q app/relay-server.js "$HOST:$RELAYDIR/relay-server.js"
  ssh "$HOST" 'kill $(pgrep -f relay-server.js) 2>/dev/null; sleep 1; cd '"$RELAYDIR"' && nohup /usr/bin/node relay-server.js >> /var/log/relay.log 2>&1 </dev/null & sleep 2; pgrep -f relay-server.js >/dev/null && echo "   已更新并重启 relay" || { echo "   ⚠ relay 启动失败！查看 /var/log/relay.log"; exit 1; }'
fi

echo "== 4/5 dmg 安装包 =="
if [ -n "$DMG" ]; then
  LATEST_DMG=$(ls -t app/dist/游戏中心-*-Mac.dmg 2>/dev/null | head -1 || true)
  if [ -n "$LATEST_DMG" ]; then
    echo "   上传 $LATEST_DMG （约 5 分钟，取决于上行带宽）…"
    scp -q "$LATEST_DMG" "$HOST:$WEBROOT/download/"
    echo "   完成。记得确认 launcher.html 下载按钮指向 $(basename "$LATEST_DMG")"
  else
    echo "   app/dist 里没有 dmg，先 npm run build:mac"
  fi
else
  echo "   跳过（需要时加 --dmg）"
fi

echo "== 5/5 验证 =="
for u in "https://xiaotuling.com/" "https://xiaotuling.com/rooms"; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$u"); echo "   $code  $u"
done
REMOTE_VER=$(curl -s --max-time 15 "https://xiaotuling.com/app/games/warthunder-game/js/main.js" | grep -m1 -oE "GAME_VERSION = '[^']+'" || true)
REMOTE_VER=${REMOTE_VER:-未取到}
LOCAL_VER=$(grep -m1 -oE "GAME_VERSION = '[^']+'" app/games/warthunder-game/js/main.js)
echo "   服务器 $REMOTE_VER / 本地 $LOCAL_VER"
[ "$REMOTE_VER" = "$LOCAL_VER" ] && echo "✅ 部署完成" || echo "⚠ 版本不一致，检查上传是否成功"
