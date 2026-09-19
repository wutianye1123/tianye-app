import * as THREE from 'three';

// 工具与资源生成器（无游戏状态依赖，便于单独测试/复用）。

// 数值钳制、插值、最短角插值、随机范围。
export function clamp(v, a, b) {
  return Math.max(a, Math.min(b, v));
}
export function lerp(a, b, t) {
  return a + (b - a) * t;
}
// 沿最短弧把角度 a 朝 b 插值 t（炮塔平滑转向用）。
export function lerpAngle(a, b, t) {
  let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
export function randRange(a, b) {
  return a + Math.random() * (b - a);
}
export function randInt(a, b) {
  return Math.floor(randRange(a, b + 1));
}

// —— Canvas 纹理生成器（云、天穹、迷彩、履带）——
export function makeSkyTexture(topColor, bottomColor) {
  const c = document.createElement('canvas'); c.width = 8; c.height = 256;
  const x = c.getContext('2d');
  const hex = (n) => '#' + n.toString(16).padStart(6, '0');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, hex(topColor)); g.addColorStop(1, hex(bottomColor));
  x.fillStyle = g; x.fillRect(0, 0, 8, 256);
  return new THREE.CanvasTexture(c);
}
export function makeCloudTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const blob = (px, py, r, a) => { const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128); };
  blob(64, 64, 64, 0.85);
  for (let i = 0; i < 7; i++) blob(32 + Math.random() * 64, 48 + Math.random() * 32, 18 + Math.random() * 28, 0.6);
  return new THREE.CanvasTexture(c);
}
let _camoTex = {};
// 国家迷彩色板：德三色(黄底棕绿块)/俄绿/美橄榄/中灰绿。纹理缓存按国家分份。
const CAMO_PALETTES = {
  rus: { base: '#5a6b4a', blobs: ['#3f4d33', '#6e7d55', '#2f3a26'] },
  ger: { base: '#967f4f', blobs: ['#6b4a35', '#4a5334', '#7a6a45'] },
  usa: { base: '#6b6b52', blobs: ['#575740', '#7a7a5e', '#4a4a38'] },
  chn: { base: '#5f6a60', blobs: ['#4d574e', '#6e7a6e', '#3f4840'] },
  gbr: { base: '#55604a', blobs: ['#414b38', '#66725a', '#333b2c'] },   // 英军青铜绿
  fra: { base: '#6b6e55', blobs: ['#565a44', '#7c8066', '#464938'] },   // 法军绿灰
  jpn: { base: '#8a8256', blobs: ['#6e6844', '#9c9468', '#5c5738'] },   // 日军黄土
};
export function camoTexture(nation = 'rus') {
  if (_camoTex[nation]) return _camoTex[nation];
  const pal = CAMO_PALETTES[nation] || CAMO_PALETTES.rus;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d');
  // 底色
  x.fillStyle = pal.base; x.fillRect(0, 0, 256, 256);
  // 三层迷彩：深色大块 → 中色中块 → 亮色小块，形状用不规则多边形（手绘斑点感）
  const blobPoly = (px, py, r, color, jitter) => {
    x.fillStyle = color; x.beginPath();
    const n = 9 + (Math.random() * 4 | 0);
    for (let k = 0; k <= n; k++) {
      const a = k / n * Math.PI * 2, rr = r * (1 - jitter / 2 + Math.random() * jitter);
      x.lineTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr * 0.8);   // y 压扁：条状迷彩更像实物
    }
    x.closePath(); x.fill();
  };
  for (let i = 0; i < 10; i++) blobPoly(Math.random() * 256, Math.random() * 256, 26 + Math.random() * 34, pal.blobs[0], 0.7);
  for (let i = 0; i < 14; i++) blobPoly(Math.random() * 256, Math.random() * 256, 12 + Math.random() * 20, pal.blobs[1], 0.6);
  for (let i = 0; i < 12; i++) blobPoly(Math.random() * 256, Math.random() * 256, 6 + Math.random() * 10, pal.blobs[2], 0.5);
  // 漆面颗粒噪点（远景看不出脏、近景有磨砂质感）
  const img = x.getImageData(0, 0, 256, 256), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 18;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  // 雨痕/划痕：几条淡淡的纵向深色细线
  x.strokeStyle = 'rgba(40,44,40,0.16)'; x.lineWidth = 1;
  for (let i = 0; i < 22; i++) {
    const sx = Math.random() * 256;
    x.beginPath(); x.moveTo(sx, Math.random() * 256); x.lineTo(sx + randRange(-6, 6), Math.random() * 256); x.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.anisotropy = 4;
  _camoTex[nation] = tex;
  return tex;
}
// 共享噪声凹凸纹理：漆面/地面的细颗粒（bumpMap），让平涂表面有微观起伏
let _noiseTex = null;
export function makeNoiseTexture() {
  if (_noiseTex) return _noiseTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const img = x.createImageData(128, 128), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 118 + (Math.random() - 0.5) * 46 + Math.sin(i * 0.37) * 6;   // 中心值≈118，微起伏
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  _noiseTex = new THREE.CanvasTexture(c);
  _noiseTex.wrapS = _noiseTex.wrapT = THREE.RepeatWrapping;
  return _noiseTex;
}
export function makeTrackTexture() {
  const c = document.createElement('canvas'); c.width = 16; c.height = 64;
  const x = c.getContext('2d');
  x.fillStyle = '#1b1b1b'; x.fillRect(0, 0, 16, 64);
  x.fillStyle = '#303030';
  for (let y = 0; y < 64; y += 8) x.fillRect(0, y, 16, 4);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1, 10);
  return t;
}

// 履带纹理（省略——见上方 makeTrackTexture）

// 烟雾贴图：白色底 + 柔和浓淡云纹（乘在白烟上只添层次不压暗——噪声图做 map 会把烟变"泥巴色"）
let _smokeTex = null;
export function makeSmokeTexture() {
  if (_smokeTex) return _smokeTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#f7f8f6'; x.fillRect(0, 0, 128, 128);   // 近白底
  const blot = (px, py, r, a) => {
    const g = x.createRadialGradient(px, py, 0, px, py, r);
    g.addColorStop(0, `rgba(215,218,214,${a})`);   // 柔和灰斑（浓度层次）
    g.addColorStop(1, 'rgba(215,218,214,0)');
    x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  };
  for (let i = 0; i < 9; i++) blot(20 + Math.random() * 88, 20 + Math.random() * 88, 26 + Math.random() * 34, 0.5);
  for (let i = 0; i < 5; i++) blot(20 + Math.random() * 88, 20 + Math.random() * 88, 14 + Math.random() * 20, 0.75);   // 几团更浓的芯
  _smokeTex = new THREE.CanvasTexture(c);
  return _smokeTex;
}

// 弹坑贴花：黑心+焦边飞溅斑（炮弹落地/爆炸在地表留痕）
let _craterTex = null;
export function makeCraterTexture() {
  if (_craterTex) return _craterTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 4, 64, 64, 60);
  g.addColorStop(0, 'rgba(12,10,8,0.95)');
  g.addColorStop(0.45, 'rgba(24,20,15,0.8)');
  g.addColorStop(0.75, 'rgba(40,34,26,0.35)');
  g.addColorStop(1, 'rgba(40,34,26,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  // 焦边飞溅：外圈随机小黑斑（翻起的焦土）
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2, r = 42 + Math.random() * 20;
    const px = 64 + Math.cos(a) * r, py = 64 + Math.sin(a) * r;
    x.fillStyle = `rgba(20,16,12,${0.25 + Math.random() * 0.4})`;
    x.beginPath(); x.arc(px, py, 2 + Math.random() * 5, 0, 7); x.fill();
  }
  _craterTex = new THREE.CanvasTexture(c);
  return _craterTex;
}

// 接地暗影贴图：径向渐变柔和黑斑（车底假 AO，让载具"压在地上"）
let _shadowTex = null;
export function makeShadowTexture() {
  if (_shadowTex) return _shadowTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(64, 64, 8, 64, 64, 62);
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, 128, 128);
  _shadowTex = new THREE.CanvasTexture(c);
  return _shadowTex;
}

// 草叶贴图：透明底上几根尖叶（alphaTest 用，近景草海）
let _grassTex = null;
export function makeGrassTexture() {
  if (_grassTex) return _grassTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const x = c.getContext('2d');
  x.lineCap = 'round';
  for (let i = 0; i < 7; i++) {
    const bx = 6 + i * 8 + randRange(-2, 2);
    const tipX = bx + randRange(-10, 10);
    const h = 34 + Math.random() * 26;
    const g = x.createLinearGradient(0, 64, 0, 64 - h);
    g.addColorStop(0, '#2f4a20');
    g.addColorStop(1, '#6a8f3c');
    x.strokeStyle = g;
    x.lineWidth = 3.4;
    x.beginPath();
    x.moveTo(bx, 64);
    x.quadraticCurveTo(bx + (tipX - bx) * 0.3, 64 - h * 0.6, tipX, 64 - h);
    x.stroke();
  }
  _grassTex = new THREE.CanvasTexture(c);
  return _grassTex;
}
// 地形高度场：分层正弦，起伏丘陵。terrainScale 按地图调整起伏强度（全局，所有调用方一致）。
// terrainMode 地形模式：normal=普通起伏；canyon=峡谷（z 轴向谷底、两侧山壁）；island=海岛（中心高地、外围沉入海面下）。
let terrainScale = 1;
let terrainMode = 'normal';
export function setTerrainScale(s) { terrainScale = s; }
export function setTerrainMode(m) { terrainMode = m || 'normal'; }
export function terrainHeight(x, z) {
  const base = (Math.sin(x * 0.013) * Math.cos(z * 0.014) * 11
    + Math.sin(x * 0.03 + 1.3) * Math.cos(z * 0.026 + 0.5) * 4
    + Math.sin((x + z) * 0.006) * 7);
  if (terrainMode === 'canyon') {
    const wall = Math.min(Math.max(0, Math.abs(x) - 55) * 1.1, 68);   // 两侧山壁：|x|>55 起坡，封顶 68m
    return base * 0.45 * terrainScale + wall;
  }
  if (terrainMode === 'island') {
    const r = Math.hypot(x, z);
    const shore = Math.max(0, r - 330) * 0.3;   // 海岛：r>330 缓降沉入海面（战场边缘浅滩）
    return base * 0.6 * terrainScale + 16 - shore;
  }
  return base * terrainScale;
}
