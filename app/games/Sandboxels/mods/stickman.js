// 真·火柴人（游戏中心出品 v3.1 白色版）—— 把每个「人类」渲染成白色火柴人：
// 白色圆脑袋＋线身＋摆动的手脚（走起来有动画），带细深色描边保证浅色背景下可见。
// v3 机制：完全独立的 requestAnimationFrame 覆盖层，不替换/不干扰游戏任何函数与返回值——
// 游戏每画一帧，我们在其后擦掉人类的头/身原像素并描画火柴人；移除模组即还原。
// 用法：模组管理器输入 stickman.js 回车，刷新生效。
(function () {
  // 单个火柴人的全部笔画（lineWidth 倍率与颜色由外层两遍调用决定：先粗深色描边，后白色本体）
  function figurePaths(ctx, cx, cy, ps, t, phase) {
    // 圆脑袋
    ctx.beginPath();
    ctx.arc(cx, cy, ps * 0.42, 0, Math.PI * 2);
    ctx.stroke();
    // 躯干线（脖子到胯）
    var hipY = cy + ps * 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, cy + ps * 0.42);
    ctx.lineTo(cx, hipY);
    ctx.stroke();
    // 腿：走路摆动
    var sw = Math.sin((t + phase) * 0.35) * ps * 0.6;
    ctx.beginPath(); ctx.moveTo(cx, hipY); ctx.lineTo(cx - sw, hipY + ps * 1.0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, hipY); ctx.lineTo(cx + sw, hipY + ps * 1.0); ctx.stroke();
    // 手臂：与腿反相摆动
    var sw2 = Math.cos((t + phase) * 0.35) * ps * 0.55;
    var shoulderY = cy + ps * 0.8;
    ctx.beginPath(); ctx.moveTo(cx, shoulderY); ctx.lineTo(cx - sw2, shoulderY + ps * 0.65); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, shoulderY); ctx.lineTo(cx + sw2, shoulderY + ps * 0.65); ctx.stroke();
  }

  function drawStickmen() {
    var canvas = document.getElementById("game");
    if (!canvas || typeof currentPixels === "undefined" || typeof pixelSize !== "number") return;
    var ctx = canvas.getContext("2d");
    var ps = pixelSize;
    var t = Math.floor(Date.now() / 150);   // 动画时钟：手脚摆动
    ctx.lineCap = "round";

    for (var i = 0; i < currentPixels.length; i++) {
      var p = currentPixels[i];
      if (p.del) continue;
      if (p.element !== "head") continue;
      var below = (pixelMap[p.x] && pixelMap[p.x][p.y + 1]) ? pixelMap[p.x][p.y + 1] : null;
      if (!below || below.element !== "body") continue;   // 只画完整的 头+身 人类

      var px = p.x * ps, py = p.y * ps;
      var cx = px + ps / 2, cy = py + ps / 2;

      // ① 擦掉底下的原像素（头+身），露出背景
      ctx.clearRect(px - 1, py - 1, ps + 2, ps + 2);
      ctx.clearRect(px - 1, py + ps - 1, ps + 2, ps + 2);

      // ② 两遍描画：先深色粗线（描边），再白色本体——浅色背景下白火柴人依然清晰
      var phase = p.x * 0.7;
      ctx.lineWidth = Math.max(1, ps * 0.30 * 1.7);
      ctx.strokeStyle = "#1a1a1a";
      figurePaths(ctx, cx, cy, ps, t, phase);
      ctx.lineWidth = Math.max(1, ps * 0.30);
      ctx.strokeStyle = "#ffffff";
      figurePaths(ctx, cx, cy, ps, t, phase);
    }

    // 第二遍：擦掉走位瞬间落单的 body 像素（消除换格残影）
    for (var j = 0; j < currentPixels.length; j++) {
      var q = currentPixels[j];
      if (q.del || q.element !== "body") continue;
      var above = (pixelMap[q.x] && pixelMap[q.x][q.y - 1]) ? pixelMap[q.x][q.y - 1] : null;
      if (above && above.element === "head") continue;   // 成对的已在上面处理
      ctx.clearRect(q.x * ps - 1, q.y * ps - 1, ps + 2, ps + 2);
    }
  }

  // 独立覆盖层循环：游戏不动我们不动它的任何函数，只在每帧后面补画
  function stickLoop() {
    try { drawStickmen(); } catch (e) { /* 渲染异常不影响游戏 */ }
    requestAnimationFrame(stickLoop);
  }
  if (document.readyState === "complete" || document.readyState === "interactive") requestAnimationFrame(stickLoop);
  else document.addEventListener("DOMContentLoaded", () => requestAnimationFrame(stickLoop));
})();
