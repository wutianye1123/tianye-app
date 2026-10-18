// 真·火柴人（游戏中心出品 v2）—— 把每个「人类」渲染成火柴人：
// 擦掉头/身两个原像素，在其位置用画布描线：圆脑袋＋线身＋摆动的手脚（走起来有动画）
// 纯渲染层，不改任何游戏逻辑/颜色/存档；移除模组即恢复原样。
// 用法：模组管理器输入 stickman.js 回车，刷新生效。
(function () {
  if (typeof drawPixels !== "function") return;   // 游戏未就绪则跳过（安全）
  var _oldDrawPixels = drawPixels;

  function drawStickmen() {
    var canvas = document.getElementById("game");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var t = Math.floor(Date.now() / 150);   // 动画时钟：手脚摆动
    ctx.lineWidth = Math.max(1, pixelSize * 0.30);
    ctx.lineCap = "round";
    ctx.strokeStyle = "#1a1a1a";

    for (var i = 0; i < currentPixels.length; i++) {
      var p = currentPixels[i];
      if (p.del) continue;
      if (p.element !== "head") continue;
      var below = (pixelMap[p.x] && pixelMap[p.x][p.y + 1]) ? pixelMap[p.x][p.y + 1] : null;
      if (!below || below.element !== "body") continue;   // 只画完整的 头+身 人类

      var px = p.x * pixelSize, py = p.y * pixelSize;
      var cx = px + pixelSize / 2, cy = py + pixelSize / 2;

      // ① 擦掉底下的原像素（头+身），露出背景
      ctx.clearRect(px - 1, py - 1, pixelSize + 2, pixelSize + 2);
      if (below) ctx.clearRect(px - 1, py + pixelSize - 1, pixelSize + 2, pixelSize + 2);

      // ② 圆脑袋
      ctx.beginPath();
      ctx.arc(cx, cy, pixelSize * 0.42, 0, Math.PI * 2);
      ctx.stroke();

      // ③ 躯干线（脖子到胯）
      var hipY = cy + pixelSize * 1.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy + pixelSize * 0.42);
      ctx.lineTo(cx, hipY);
      ctx.stroke();

      // ④ 腿：走路摆动（相位随位置错开，一群人不会同手同脚）
      var sw = Math.sin((t + p.x * 0.7) * 0.35) * pixelSize * 0.6;
      ctx.beginPath(); ctx.moveTo(cx, hipY); ctx.lineTo(cx - sw, hipY + pixelSize * 1.0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, hipY); ctx.lineTo(cx + sw, hipY + pixelSize * 1.0); ctx.stroke();

      // ⑤ 手臂：与腿反相摆动
      var sw2 = Math.cos((t + p.x * 0.7) * 0.35) * pixelSize * 0.55;
      var shoulderY = cy + pixelSize * 0.8;
      ctx.beginPath(); ctx.moveTo(cx, shoulderY); ctx.lineTo(cx - sw2, shoulderY + pixelSize * 0.65); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx, shoulderY); ctx.lineTo(cx + sw2, shoulderY + pixelSize * 0.65); ctx.stroke();
    }

    // 第二遍：擦掉走位瞬间落单的 body 像素（消除换格残影）
    for (var j = 0; j < currentPixels.length; j++) {
      var q = currentPixels[j];
      if (q.del || q.element !== "body") continue;
      var above = (pixelMap[q.x] && pixelMap[q.x][q.y - 1]) ? pixelMap[q.x][q.y - 1] : null;
      if (above && above.element === "head") continue;   // 成对的已在上面处理
      ctx.clearRect(q.x * pixelSize - 1, q.y * pixelSize - 1, pixelSize + 2, pixelSize + 2);
    }
  }

  drawPixels = function (forceTick) {
    _oldDrawPixels(forceTick);
    try { drawStickmen(); } catch (e) { /* 渲染失败不影响游戏 */ }
  };
})();
