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
let _camoTex = null;
export function camoTexture() {
  if (_camoTex) return _camoTex;
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = '#bdbdbd'; x.fillRect(0, 0, 128, 128);
  x.fillStyle = '#6f6f6f';
  for (let i = 0; i < 16; i++) {
    const px = Math.random() * 128, py = Math.random() * 128, r = 9 + Math.random() * 20;
    x.beginPath();
    for (let k = 0; k <= 8; k++) { const a = k / 8 * Math.PI * 2, rr = r * (0.7 + Math.random() * 0.5); x.lineTo(px + Math.cos(a) * rr, py + Math.sin(a) * rr); }
    x.closePath(); x.fill();
  }
  x.fillStyle = '#e6e6e6';
  for (let i = 0; i < 10; i++) { x.beginPath(); x.arc(Math.random() * 128, Math.random() * 128, 5 + Math.random() * 12, 0, 7); x.fill(); }
  _camoTex = new THREE.CanvasTexture(c);
  _camoTex.wrapS = _camoTex.wrapT = THREE.RepeatWrapping;
  _camoTex.repeat.set(2, 2);
  return _camoTex;
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

// 地形高度场（分层正弦，起伏丘陵）。
export function terrainHeight(x, z) {
  return Math.sin(x * 0.013) * Math.cos(z * 0.014) * 11
    + Math.sin(x * 0.03 + 1.3) * Math.cos(z * 0.026 + 0.5) * 4
    + Math.sin((x + z) * 0.006) * 7;
}
