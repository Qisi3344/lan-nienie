/* 小海捏捏 — 史莱姆 + 猫爪揉捏  (Hark 为绮思手写, 2026-10-15)
   window.Slime.init(containerEl)
   - 高度场软体：粘性回流 + 体积挤出（按下去四周鼓起）
   - 每根手指一只猫爪，按下去是肉垫形状的坑，拖动会拖着史莱姆走
   - 星星/贝壳/海豚：稍硬的小装饰，被推开、跟着流、陷下去、倾斜
   - WebGL 折射 + 高光；WebAudio 咕唧声 */
(function () {
  'use strict';
  const N = 200;            // 高度场分辨率
  const R = 0.47;           // 盒子半径（tub uv）
  const S = 0.08;          // 爪子尺度（tub uv）
  const DECAY = 0.9965;     // 慢慢回平
  const KDIFF = 0.035;       // 粘性流动（越小越粘）
  const GS = 1.7;           // 法线强度

  let h, tmp, cpy, mask;
  let ringIdx, ringW;
  let L = 400, cx = 200, cy = 200, W = 400, H = 400, dpr = 1;
  let gl, glc, ov, ctx, prog, texN, texG, nData, uni = {};
  const pullA=new Float32Array(24),pullB=new Float32Array(24),pullBounds=new Float32Array(8),pullActive=new Float32Array(2);
  const returningGel=[];
  let paws = new Map();
  let decos = [];
  let muted = false;
  let last = 0;
  let root;

  const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
  const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  /* ---------------- 高度场 ---------------- */
  function initField() {
    h = new Float32Array(N * N); tmp = new Float32Array(N * N); cpy = new Float32Array(N * N);
    mask = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const u = (i + 0.5) / N - 0.5, v = (j + 0.5) / N - 0.5;
      mask[j * N + i] = Math.hypot(u, v) < R + 0.6 / N ? 1 : 0;
    }
    const m = Math.ceil(S * N * 2.2) * 2 + 3;
    ringIdx = new Int32Array(m * m); ringW = new Float32Array(m * m);
    nData = new Uint8Array(N * N * 4);
  }

  function diffuse() {
    const k = KDIFF;
    for (let j = 1; j < N - 1; j++) {
      let p = j * N;
      for (let i = 1; i < N - 1; i++) {
        p = j * N + i;
        if (!mask[p]) { tmp[p] = 0; continue; }
        const c = h[p]; let s = 0;
        if (mask[p - 1]) s += h[p - 1] - c;
        if (mask[p + 1]) s += h[p + 1] - c;
        if (mask[p - N]) s += h[p - N] - c;
        if (mask[p + N]) s += h[p + N] - c;
        tmp[p] = (c + k * s) * DECAY;
      }
    }
    const t = h; h = tmp; tmp = t;
  }

  function sdE(x, y, ex, ey, rx, ry) {
    const dx = (x - ex) / rx, dy = (y - ey) / ry;
    return (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry);
  }
  function smin(a, b, k) { const q = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - q * q * k * 0.25; }
  // 猫爪肉垫 SDF（单位 = S，+y 朝脚趾方向）
  function pawSD(x, y) {
    let d = sdE(x, y, 0, -0.34, 0.5, 0.33);
    d = smin(d, sdE(x, y, -0.29, -0.13, 0.26, 0.26), 0.22);
    d = smin(d, sdE(x, y, 0.29, -0.13, 0.26, 0.26), 0.22);
    d = smin(d, sdE(x, y, 0, -0.1, 0.3, 0.24), 0.22);
    d = Math.min(d, sdE(x, y, -0.66, 0.31, 0.18, 0.22));
    d = Math.min(d, sdE(x, y, -0.24, 0.6, 0.19, 0.235));
    d = Math.min(d, sdE(x, y, 0.24, 0.6, 0.19, 0.235));
    d = Math.min(d, sdE(x, y, 0.66, 0.31, 0.18, 0.22));
    return d;
  }

  function stamp(p) {
    if (!p.down || p.grab || p.lifted) return; // 松开后坑留着，慢慢回流
    const D = p.press * 1.15;
    if (D < 0.03) return;
    const sc = S * N, cu = p.u * N, cv = p.v * N;
    const rad = Math.ceil(sc * 1.75);
    const fx = p.fx, fy = p.fy;
    let deficit = 0, wsum = 0, nr = 0;
    const i0 = Math.max(1, Math.floor(cu - rad)), i1 = Math.min(N - 2, Math.ceil(cu + rad));
    const j0 = Math.max(1, Math.floor(cv - rad)), j1 = Math.min(N - 2, Math.ceil(cv + rad));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const q = j * N + i; if (!mask[q]) continue;
      const ox = (i + 0.5 - cu) / sc, oy = (j + 0.5 - cv) / sc;
      const ly = ox * fx + oy * fy, lx = -ox * fy + oy * fx;
      const r = Math.hypot(lx, ly + 0.05);
      if (r < 1.0) {
        const sd = pawSD(lx, ly);
        const sv = sstep(0.07, -0.07, sd);
        const G = Math.max(0, 1 - (r / 1.0) * (r / 1.0));
        // 肉垫处压深，肉垫之间被挤得微微鼓起
        const t = -D * (0.8 * sv + 0.12 * G) + D * 0.12 * (1 - sv) * G * G;
        const blend = sstep(1.0, 0.75, r);
        const nh = h[q] + (t - h[q]) * blend;
        deficit += h[q] - nh; h[q] = nh;
      } else if (r < 1.75) {
        const w = Math.exp(-(((r - 1.22) / 0.22) ** 2));
        ringIdx[nr] = q; ringW[nr] = w; nr++; wsum += w;
      }
    }
    if (wsum > 0) {
      const f = deficit / wsum;
      for (let k = 0; k < nr; k++) h[ringIdx[k]] += ringW[k] * f;
    }
  }

  function sampleH(a, x, y) { // x,y 网格坐标（cell 中心为 i+0.5）
    x -= 0.5; y -= 0.5;
    const i = Math.floor(x), j = Math.floor(y);
    if (i < 0 || j < 0 || i >= N - 1 || j >= N - 1) return 0;
    const fx = x - i, fy = y - j, p = j * N + i;
    return (a[p] * (1 - fx) + a[p + 1] * fx) * (1 - fy) + (a[p + N] * (1 - fx) + a[p + N + 1] * fx) * fy;
  }

  // 拖动：附近的史莱姆被黏着一起走
  function smear(p, du, dv) {
    const sc = S * N, cu = p.u * N, cv = p.v * N;
    const rad = Math.ceil(sc * 2.1);
    const i0 = Math.max(1, Math.floor(cu - rad)), i1 = Math.min(N - 2, Math.ceil(cu + rad));
    const j0 = Math.max(1, Math.floor(cv - rad)), j1 = Math.min(N - 2, Math.ceil(cv + rad));
    for (let j = j0 - 1; j <= j1 + 1; j++) for (let i = i0 - 1; i <= i1 + 1; i++) { const q = j * N + i; if (q >= 0 && q < N * N) cpy[q] = h[q]; }
    const ddx = du * N, ddy = dv * N;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const q = j * N + i; if (!mask[q]) continue;
      const dist = Math.hypot(i + 0.5 - cu, j + 0.5 - cv) / sc;
      const f = sstep(2.1, 0.6, dist) * 0.85 * p.press;
      if (f <= 0) continue;
      h[q] = sampleH(cpy, i + 0.5 - ddx * f, j + 0.5 - ddy * f);
    }
  }

  function hAt(u, v) { return sampleH(h, u * N, v * N); }
  function gradAt(u, v) {
    const e = 1.5;
    return [(sampleH(h, u * N + e, v * N) - sampleH(h, u * N - e, v * N)) / (2 * e),
            (sampleH(h, u * N, v * N + e) - sampleH(h, u * N, v * N - e)) / (2 * e)];
  }

  function buildNormals() {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const p = j * N + i, o = p * 4;
      if (!mask[p] || i === 0 || j === 0 || i === N - 1 || j === N - 1) { nData[o] = 128; nData[o + 1] = 128; nData[o + 2] = 128; nData[o + 3] = 255; continue; }
      const c = h[p];
      const l = mask[p - 1] ? h[p - 1] : c, r = mask[p + 1] ? h[p + 1] : c;
      const t = mask[p - N] ? h[p - N] : c, b = mask[p + N] ? h[p + N] : c;
      const gx = clamp((r - l) * 0.5 * GS, -1, 1), gy = clamp((b - t) * 0.5 * GS, -1, 1);
      nData[o] = 128 + gx * 127; nData[o + 1] = 128 + gy * 127;
      nData[o + 2] = clamp(128 + c * 63.5, 0, 255); nData[o + 3] = 255;
    }
  }

  /* ---------------- 闪粉底（透过史莱姆看到的） ---------------- */
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function makeGlitter() {
    const c = document.createElement('canvas'); c.width = c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#C9F0EC'; g.fillRect(0, 0, 1024, 1024);
    // 底部淡淡的深浅
    for (let k = 0; k < 40; k++) {
      const x = rnd(0, 1024), y = rnd(0, 1024), r = rnd(60, 200);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, Math.random() < 0.5 ? 'rgba(150,225,220,0.35)' : 'rgba(235,252,250,0.35)');
      gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    const mint = ['#86DCD5', '#9FE6E0', '#6FD0CA', '#B8F0EB', '#E8FFFD', '#7AD7E0'];
    function hex(x, y, r, rot) { g.beginPath(); for (let k = 0; k < 6; k++) { const a = rot + k * Math.PI / 3; g.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); } g.closePath(); }
    function flower(x, y, r, rot) { g.beginPath(); for (let k = 0; k < 12; k++) { const a = rot + k * Math.PI / 6; const rr = k % 2 ? r * 0.72 : r; g.lineTo(x + rr * Math.cos(a), y + rr * Math.sin(a)); } g.closePath(); }
    // 雪花碎片团（边缘更密）
    for (let k = 0; k < 5200; k++) {
      let x, y, ok = false;
      for (let t = 0; t < 4 && !ok; t++) {
        x = rnd(0, 1024); y = rnd(0, 1024);
        const r = Math.hypot(x - 512, y - 512) / 512;
        ok = Math.random() < 0.35 + 0.65 * sstep(0.3, 0.95, r);
      }
      const s = rnd(4, 13);
      g.fillStyle = mint[(Math.random() * mint.length) | 0];
      g.globalAlpha = rnd(0.55, 0.95);
      if (Math.random() < 0.5) flower(x, y, s, rnd(0, 6)); else hex(x, y, s * 0.8, rnd(0, 6));
      g.fill();
      if (Math.random() < 0.25) { g.globalAlpha = 0.7; g.fillStyle = '#FFFFFF'; g.beginPath(); g.arc(x - s * 0.25, y - s * 0.25, s * 0.25, 0, 7); g.fill(); }
    }
    // 镭射亮片
    const iri = ['#FFFFFF', '#F4E9FF', '#E3F7FF', '#FFEAF4', '#EFFFF6'];
    for (let k = 0; k < 260; k++) {
      const x = rnd(0, 1024), y = rnd(0, 1024), s = rnd(7, 15);
      g.globalAlpha = rnd(0.7, 1);
      g.fillStyle = iri[(Math.random() * iri.length) | 0];
      if (Math.random() < 0.35) { starPath(g, x, y, s, s * 0.45, rnd(0, 6)); } else hex(x, y, s * 0.75, rnd(0, 6));
      g.fill();
      g.globalAlpha = 0.5; g.strokeStyle = '#B9C4D6'; g.lineWidth = 1; g.stroke();
    }
    // 小气泡
    for (let k = 0; k < 90; k++) {
      const x = rnd(0, 1024), y = rnd(0, 1024), s = rnd(2, 6);
      g.globalAlpha = 0.6; g.strokeStyle = '#FFFFFF'; g.lineWidth = 1.2; g.beginPath(); g.arc(x, y, s, 0, 7); g.stroke();
    }
    g.globalAlpha = 1;
    return c;
  }

  /* ---------------- 装饰精灵 ---------------- */
  function starPath(g, x, y, Ro, Ri, rot) {
    g.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = rot - Math.PI / 2 + k * Math.PI / 5, r = k % 2 ? Ri : Ro;
      g.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    g.closePath();
  }
  function sprite(sz, draw) {
    const pad = Math.round(sz * 0.14);
    const a = document.createElement('canvas'); a.width = a.height = sz;
    draw(a.getContext('2d'), sz);
    const b = document.createElement('canvas'); b.width = b.height = sz + pad * 2;
    const g = b.getContext('2d');
    g.shadowColor = 'rgba(40,90,95,0.32)'; g.shadowBlur = sz * 0.05; g.shadowOffsetX = sz * 0.02; g.shadowOffsetY = sz * 0.035;
    g.drawImage(a, pad, pad);
    b.k = (sz + pad * 2) / sz;
    return b;
  }
  function puffyStar(base, dot, stitch) {
    return sprite(320, (g, s) => {
      const c = s / 2, Ro = s * 0.44, Ri = s * 0.23;
      g.lineJoin = 'round';
      starPath(g, c, c + s * 0.03, Ro * 0.9, Ri * 0.95, 0.12);
      g.fillStyle = base; g.strokeStyle = base; g.lineWidth = s * 0.09; g.fill(); g.stroke();
      g.save(); g.clip(); g.restore();
      // 鼓鼓的明暗
      g.save();
      starPath(g, c, c + s * 0.03, Ro * 0.9, Ri * 0.95, 0.12); g.lineWidth = s * 0.09; g.stroke();
      g.globalCompositeOperation = 'source-atop';
      const gr = g.createRadialGradient(c - s * 0.12, c - s * 0.14, s * 0.02, c, c, s * 0.5);
      gr.addColorStop(0, 'rgba(255,255,255,0.28)'); gr.addColorStop(0.55, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(0,0,0,0.22)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
      // 波点
      g.fillStyle = dot;
      const st = s * 0.105;
      for (let y = 0, row = 0; y < s; y += st * 0.87, row++) for (let x = (row % 2) * st / 2; x < s; x += st) {
        g.beginPath(); g.arc(x, y, s * 0.019, 0, 7); g.fill();
      }
      g.restore();
      // 车线
      g.save(); g.setLineDash([s * 0.02, s * 0.018]); g.strokeStyle = stitch; g.lineWidth = s * 0.008;
      starPath(g, c, c + s * 0.03, Ro * 0.86, Ri * 0.9, 0.12); g.stroke(); g.restore();
    });
  }
  function silverStar() {
    return sprite(200, (g, s) => {
      const c = s / 2; g.lineJoin = 'round';
      starPath(g, c, c, s * 0.42, s * 0.2, 0);
      const gr = g.createLinearGradient(0, 0, s, s);
      gr.addColorStop(0, '#FFFFFF'); gr.addColorStop(0.45, '#C9CDD6'); gr.addColorStop(0.6, '#F5F6FA'); gr.addColorStop(1, '#9EA4B0');
      g.fillStyle = gr; g.strokeStyle = '#F2F3F7'; g.lineWidth = s * 0.05; g.fill(); g.stroke();
      g.save(); starPath(g, c, c, s * 0.42, s * 0.2, 0); g.clip();
      g.fillStyle = 'rgba(120,128,140,0.55)';
      for (let y = 0; y < s; y += s * 0.05) for (let x = 0; x < s; x += s * 0.05) { g.beginPath(); g.arc(x, y, s * 0.011, 0, 7); g.fill(); }
      g.restore();
    });
  }
  function shell(col, light) {
    return sprite(200, (g, s) => {
      const c = s / 2;
      const gr = g.createRadialGradient(c - s * 0.1, c - s * 0.12, s * 0.03, c, c, s * 0.46);
      gr.addColorStop(0, light); gr.addColorStop(1, col);
      g.fillStyle = gr; g.beginPath(); g.ellipse(c, c, s * 0.42, s * 0.39, 0.3, 0, 7); g.fill();
      // 螺旋
      g.strokeStyle = light; g.lineWidth = s * 0.06; g.lineCap = 'round'; g.beginPath();
      for (let t = 0; t < 1; t += 0.01) {
        const a = t * Math.PI * 4.2, r = s * (0.03 + 0.31 * t);
        g.lineTo(c + r * Math.cos(a) + s * 0.02, c + r * Math.sin(a) * 0.95);
      }
      g.stroke();
      g.strokeStyle = 'rgba(40,30,80,0.25)'; g.lineWidth = s * 0.02; g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath(); g.ellipse(c - s * 0.16, c - s * 0.2, s * 0.06, s * 0.035, -0.6, 0, 7); g.fill();
      for (const [x, y] of [[0.68, 0.32], [0.3, 0.7], [0.72, 0.66]]) { g.beginPath(); g.arc(s * x, s * y, s * 0.014, 0, 7); g.fill(); }
    });
  }
  function dolphin() {
    return sprite(400, (g, s) => {
      const k = s / 200;
      g.save(); g.scale(k, k); g.translate(100, 100); g.rotate(-0.18); g.translate(-94, -88);
      // 圆滚滚的海豚（侧面，朝右）
      const body = new Path2D();
      body.moveTo(182, 95);                                   // 嘴尖
      body.quadraticCurveTo(170, 84, 154, 82);                // 嘴→额头下
      body.bezierCurveTo(150, 58, 126, 48, 102, 52);          // 圆额头→背
      body.bezierCurveTo(74, 56, 50, 74, 36, 98);             // 背→尾柄
      body.quadraticCurveTo(30, 108, 24, 116);
      body.quadraticCurveTo(12, 100, 2, 104);                 // 上尾叶
      body.quadraticCurveTo(14, 118, 16, 140);
      body.quadraticCurveTo(28, 126, 48, 132);                // 下尾叶
      body.quadraticCurveTo(40, 122, 40, 116);
      body.bezierCurveTo(60, 110, 90, 114, 116, 112);         // 肚子
      body.bezierCurveTo(138, 110, 152, 104, 162, 100);
      body.quadraticCurveTo(172, 100, 182, 95);
      body.closePath();
      const fin = new Path2D();
      fin.moveTo(98, 54); fin.quadraticCurveTo(100, 30, 84, 22); fin.quadraticCurveTo(82, 42, 70, 62); fin.closePath();
      const flip = new Path2D();
      flip.moveTo(128, 108); flip.quadraticCurveTo(124, 130, 106, 138); flip.quadraticCurveTo(116, 122, 112, 110); flip.closePath();
      const fill = g.createLinearGradient(60, 40, 140, 140);
      fill.addColorStop(0, 'rgba(120,236,242,0.95)'); fill.addColorStop(1, 'rgba(28,172,194,0.95)');
      for (const pth of [fin, flip, body]) { g.fillStyle = fill; g.fill(pth); }
      // 肚皮浅一点
      g.save(); g.clip(body);
      g.fillStyle = 'rgba(210,252,255,0.45)'; g.beginPath(); g.ellipse(120, 112, 52, 12, -0.08, 0, 7); g.fill();
      for (let n = 0; n < 1100; n++) {
        const x = rnd(0, 200), y = rnd(10, 150);
        g.fillStyle = Math.random() < 0.6 ? 'rgba(255,255,255,0.75)' : 'rgba(170,250,255,0.95)';
        g.beginPath(); g.arc(x, y, rnd(0.4, 1.3), 0, 7); g.fill();
      }
      g.restore();
      g.lineJoin = 'round';
      for (const pth of [fin, flip, body]) { g.strokeStyle = 'rgba(205,253,255,0.95)'; g.lineWidth = 2.4; g.stroke(pth); }
      // 背上高光
      g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 2.6; g.lineCap = 'round';
      g.beginPath(); g.moveTo(140, 62); g.bezierCurveTo(124, 54, 96, 58, 74, 72); g.stroke();
      // 嘴线 + 水钻眼睛
      g.strokeStyle = 'rgba(20,120,140,0.6)'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(178, 96); g.quadraticCurveTo(168, 98, 158, 95); g.stroke();
      const ex = 146, ey = 82;
      g.fillStyle = '#FFFFFF'; g.beginPath(); g.arc(ex, ey, 4.6, 0, 7); g.fill();
      g.fillStyle = '#B8CDE3'; g.beginPath(); g.arc(ex + 1, ey + 1, 2.4, 0, 7); g.fill();
      g.strokeStyle = '#FFFFFF'; g.lineWidth = 1; g.beginPath(); g.moveTo(ex - 8, ey); g.lineTo(ex + 8, ey); g.moveTo(ex, ey - 8); g.lineTo(ex, ey + 8); g.stroke();
      g.restore();
    });
  }
  function foamBead(col) {
    return sprite(80, (g, s) => {
      const c = s / 2, gr = g.createRadialGradient(c - s * 0.12, c - s * 0.14, s * 0.02, c, c, s * 0.42);
      gr.addColorStop(0, '#FFFFFF'); gr.addColorStop(0.6, col); gr.addColorStop(1, 'rgba(150,170,190,1)');
      g.fillStyle = gr; g.beginPath(); g.arc(c, c, s * 0.4, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.9)'; g.beginPath(); g.ellipse(c - s * 0.13, c - s * 0.15, s * 0.09, s * 0.06, -0.6, 0, 7); g.fill();
    });
  }
  function sequin(c1, c2) {
    return sprite(80, (g, s) => {
      const c = s / 2; g.beginPath();
      for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3; g.lineTo(c + s * 0.38 * Math.cos(a), c + s * 0.38 * Math.sin(a)); }
      g.closePath();
      const gr = g.createLinearGradient(0, 0, s, s); gr.addColorStop(0, c1); gr.addColorStop(0.5, '#FFFFFF'); gr.addColorStop(1, c2);
      g.fillStyle = gr; g.fill(); g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = s * 0.04; g.stroke();
      g.fillStyle = 'rgba(160,170,200,0.5)'; g.beginPath(); g.arc(c, c, s * 0.06, 0, 7); g.fill();
    });
  }
  let topSpr = null;

  function makeDecos() {
    const black = puffyStar('#1F1E26', '#F2F1F6', 'rgba(255,255,255,0.35)');
    const white = puffyStar('#FAF9F7', '#1F1E26', 'rgba(150,150,160,0.55)');
    const silv = silverStar();
    const sh1 = shell('#7D6BC9', '#D9CCFF'), sh2 = shell('#3E77B8', '#BFE3FF');
    const dol = dolphin();
    topSpr = {
      bead: [foamBead('#FFFFFF'), foamBead('#FFE3EE'), foamBead('#E6F0FF'), foamBead('#E9FFF6')],
      seq: [sequin('#FFD6EA', '#BFE8FF'), sequin('#E0D4FF', '#C9FFF2'), sequin('#FFF3C4', '#FFC9E0')]
    };
    const list = [
      { img: dol, u: 0.6, v: 0.5, size: 0.42, a: 0.0, z: 1, m: 2.2 },
      { img: black, u: 0.33, v: 0.4, size: 0.24, a: -0.1, z: 3, m: 1 },
      { img: white, u: 0.27, v: 0.66, size: 0.22, a: 0.25, z: 2, m: 1 },
      { img: sh1, u: 0.5, v: 0.2, size: 0.1, a: 0, z: 4, m: 0.7 },
      { img: sh2, u: 0.57, v: 0.8, size: 0.1, a: 0.5, z: 4, m: 0.7 },
      { img: silv, u: 0.63, v: 0.22, size: 0.085, a: 0.2, z: 0, m: 0.5 },
      { img: silv, u: 0.44, v: 0.83, size: 0.08, a: -0.3, z: 0, m: 0.5 },
      { img: silv, u: 0.84, v: 0.66, size: 0.075, a: 0.6, z: 0, m: 0.5 },
      { img: silv, u: 0.27, v: 0.24, size: 0.07, a: 0.1, z: 0, m: 0.5 },
      { img: silv, u: 0.42, v: 0.55, size: 0.065, a: -0.5, z: 0, m: 0.5 },
    ];
    decos = list.map(d => Object.assign(d, { hu: d.u, hv: d.v, ha: d.a, r: d.size * 0.42, sink: 0, va: 0, home: 0, drop: 0 }));
    decos.sort((a, b) => a.z - b.z);
  }

  function addToppings(kind) {
    const n = kind === 'bead' ? 16 : 12;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, rr = Math.sqrt(Math.random()) * (R - 0.05);
      const arr = topSpr[kind], img = arr[(Math.random() * arr.length) | 0];
      const size = kind === 'bead' ? rnd(0.028, 0.038) : rnd(0.034, 0.046);
      const u = 0.5 + Math.cos(a) * rr, v = 0.5 + Math.sin(a) * rr;
      decos.push({ img, u, v, hu: u, hv: v, a: rnd(0, 6), ha: 0, size, r: size * 0.42, z: 0.5, m: 0.3, sink: 0, va: 0, home: 0,
        drop: 1 + Math.random() * 0.8, topping: true, crunchy: kind === 'bead' });
    }
    let extra = decos.filter(d => d.topping).length - 96;
    decos = decos.filter(d => !(d.topping && extra-- > 0));
    decos.sort((a, b) => a.z - b.z);
    sprinkleSound(n);
  }

  let crunchBudget = 0;
  function updateDecos(dt) {
    crunchBudget = 2;
    for (const d of decos) {
      let pressOn = 0, moving = 0;
      for (const p of paws.values()) {
        if (p.press < 0.15 || p.grab || p.lifted) continue;
        const dx = d.u - p.u, dy = d.v - p.v, dist = Math.hypot(dx, dy) + 1e-6;
        const contact = S * 1.0 + d.r * 0.55;
        const follow = sstep(contact + S * 1.2, contact * 0.4, dist) * p.press * (0.75 / Math.sqrt(d.m));
        d.u += p.du * follow; d.v += p.dv * follow;
        d.va += (dx * p.dv - dy * p.du) / (dist * dist + 0.01) * follow * 0.05;
        if (dist < contact) {
          const push = (contact - dist) * 0.22 * p.press / d.m;
          d.u += dx / dist * push; d.v += dy / dist * push;
          pressOn = Math.max(pressOn, p.press * sstep(contact, contact * 0.3, dist));
          moving += Math.hypot(p.du, p.dv);
        }
      }
      if (d.crunchy && pressOn > 0.3 && crunchBudget > 0 && Math.random() < 0.04 + moving * 25) { crunch(); crunchBudget--; }
      d.sink += (pressOn - d.sink) * Math.min(1, dt * 10);
      d.a += d.va; d.va *= 0.86;
      if (d.drop > 0) d.drop = Math.max(0, d.drop - dt * 3.2);
      for (const e of decos) {
        if (e === d) continue;
        const dx = d.u - e.u, dy = d.v - e.v;
        if (Math.abs(dx) > 0.3 || Math.abs(dy) > 0.3) continue;
        const dist = Math.hypot(dx, dy) + 1e-6, mn = (d.r + e.r) * 0.55;
        if (dist < mn) { const f = (mn - dist) * 0.06 * e.m / (d.m + e.m); d.u += dx / dist * f; d.v += dy / dist * f; }
      }
      const ox = d.u - 0.5, oy = d.v - 0.5, rr = Math.hypot(ox, oy), lim = R - d.r * 0.75;
      if (rr > lim) { d.u = 0.5 + ox / rr * lim; d.v = 0.5 + oy / rr * lim; }
      if (d.home > 0) {
        const k = Math.min(1, dt * 4);
        d.u += (d.hu - d.u) * k; d.v += (d.hv - d.v) * k; d.a += (d.ha - d.a) * k;
        d.home -= dt;
      }
    }
  }

  /* ---------------- WebGL ---------------- */
  const VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
  const FS = `precision highp float;
uniform sampler2D uN, uG; uniform vec2 uRes, uC; uniform float uL, uR, uT, uFoc, uHZ; uniform vec3 uCam, uF, uRt, uUp;
uniform vec4 uPullA[6],uPullB[6],uPullBounds[2]; uniform vec2 uPullActive;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
 return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*noise(p);p*=2.03;a*=.5;}return s;}

float gelUnion(float a,float b,float k){float f=max(k-abs(a-b),0.)/k;return min(a,b)-f*f*k*0.25;}
float tubeA(vec3 x){
 float d=9.;
 for(int i=0;i<5;i++){
  vec4 a=uPullA[i],b=uPullA[i+1];vec3 v=b.xyz-a.xyz;
  float t=clamp(dot(x-a.xyz,v)/max(dot(v,v),0.000001),0.,1.);
  d=gelUnion(d,length(x-a.xyz-v*t)-mix(a.w,b.w,t),0.006);
 }
 return d;
}
float tubeB(vec3 x){
 float d=9.;
 for(int i=0;i<5;i++){
  vec4 a=uPullB[i],b=uPullB[i+1];vec3 v=b.xyz-a.xyz;
  float t=clamp(dot(x-a.xyz,v)/max(dot(v,v),0.000001),0.,1.);
  d=gelUnion(d,length(x-a.xyz-v*t)-mix(a.w,b.w,t),0.006);
 }
 return d;
}
float unifiedGel(vec3 p,int hand){
 float tube=hand==0?tubeA(p):tubeB(p);
 float surface=(texture2D(uN,p.xy+0.5).b-0.5)*4.*uHZ;
 float basin=max(p.z-surface,length(p.xy)-uR);
 return gelUnion(tube,basin,0.019);
}
float rayGel(vec3 eye,vec3 ray,vec4 ball,int hand,float limit){
 vec3 oc=eye-ball.xyz;
 float b=dot(oc,ray),c=dot(oc,oc)-ball.w*ball.w;
 float disc=b*b-c;if(disc<=0.)return -1.;
 float d=sqrt(disc),t=max(0.,-b-d),far=-b+d;
 if(t>=limit)return -1.;
 for(int i=0;i<42;i++){
  if(t>far || t>=limit)break;
  float gap=unifiedGel(eye+ray*t,hand);
  if(gap<0.0012)return t;
  t+=max(0.0016,gap*0.82);
 }
 return -1.;
}
vec3 gelNorm(vec3 p,int hand){
 float e=0.0018;
 return normalize(vec3(
  unifiedGel(p+vec3(e,0.,0.),hand)-unifiedGel(p-vec3(e,0.,0.),hand),
  unifiedGel(p+vec3(0.,e,0.),hand)-unifiedGel(p-vec3(0.,e,0.),hand),
  unifiedGel(p+vec3(0.,0.,e),hand)-unifiedGel(p-vec3(0.,0.,e),hand)
 ));
}
void main(){
 vec2 fc=vec2(gl_FragCoord.x,uRes.y-gl_FragCoord.y);
 vec3 dir=normalize(uF*uFoc+uRt*(fc.x-uC.x)-uUp*(fc.y-uC.y));
 float TB=-0.055, RW=uR+0.024, ZR=0.01;
 float tt=(TB-uCam.z)/dir.z; vec3 P=uCam+dir*tt;
 vec2 sp=P.xy*1.6;
 float v=fbm(sp*2.2+vec2(fbm(sp*1.7+3.1)*2.5,0.));
 float vein=smoothstep(0.035,0.0,abs(v-0.52))*0.10+smoothstep(0.012,0.0,abs(v-0.40))*0.06;
 vec3 col=vec3(0.945,0.945,0.955)-vein*vec3(0.55,0.55,0.5)+(noise(sp*300.)-0.5)*0.012;
 float sh=smoothstep(RW+0.09,RW-0.02,length(P.xy-vec2(0.035,0.07)));
 col*=1.-0.2*sh;
 vec2 o=uCam.xy, dd=dir.xy; float qa=dot(dd,dd), qb=dot(o,dd), qc=dot(o,o)-RW*RW; float disc=qb*qb-qa*qc;
 if(disc>0.){
  float tc=(-qb-sqrt(disc))/qa; vec3 Q=uCam+dir*tc;
  if(Q.z>TB&&Q.z<ZR){
   vec2 nn=normalize(Q.xy);
   float lit=0.5+0.5*dot(nn,normalize(vec2(-0.6,0.5)));
   float k=(Q.z-TB)/(ZR-TB);
   vec3 wc=vec3(0.86,0.93,0.94)*(0.8+0.18*lit)+0.06*k;
   wc+=smoothstep(0.08,0.0,abs(nn.x+0.55))*0.12;
   wc=mix(wc,vec3(0.55,0.82,0.82),0.18*(1.-k));
   col=wc;
  }
 }
 float t0=(ZR-uCam.z)/dir.z; vec2 T0=(uCam+dir*t0).xy; float r0=length(T0);
 if(r0<RW&&r0>uR-0.002){
  float e=(r0-uR)/(RW-uR);
  float hi=0.5+0.5*smoothstep(0.3,-0.7,dot(normalize(T0),vec2(0.7,0.7)));
  col=mix(vec3(0.9,0.95,0.96),vec3(1.),hi)*(0.94+0.06*sin(e*3.14));
 }
 float ts=-uCam.z/dir.z; vec2 xy=(uCam+dir*ts).xy;
 if(length(xy)<uR+0.002){
  float h0=(texture2D(uN,xy+0.5).b-0.5)*4.;
  ts=(h0*uHZ-uCam.z)/dir.z; xy=(uCam+dir*ts).xy;
  vec2 uv=xy+0.5; vec2 d=xy; float r=length(d);
  vec4 nt=texture2D(uN,uv);
  vec2 g=(nt.rg-0.5)*2.;
  float hh=(nt.b-0.5)*4.;
  float rr=min(r/uR,1.); vec2 dir2=d/max(r,1e-4);
  float men=smoothstep(0.86,1.0,rr);
  vec3 n=normalize(vec3(-g*1.05-dir2*men*0.9,1.));
  vec2 off=-n.xy*0.03*(1.+0.35*hh)+dir.xy*0.02;
  vec3 gc=texture2D(uG,uv+off).rgb;
  float thick=clamp(0.6+0.2*hh,0.15,1.0);
  vec3 tint=vec3(0.50,0.85,0.84);
  vec3 c=mix(gc,gc*tint*1.12,thick*0.55);
  c*=clamp(1.+0.13*hh,0.72,1.08);
  vec3 Ld=normalize(vec3(-0.45,-0.55,0.72));
  c*=0.82+0.28*max(dot(n,Ld),0.)/0.72;
  vec3 Hv=normalize(Ld-dir);
  float nh=max(dot(n,Hv),0.);
  float spec=pow(nh,160.)*1.4+pow(nh,24.)*0.14;
  vec3 Rf=reflect(dir,n);
  float win=smoothstep(0.11,0.07,abs(Rf.x+0.28))*smoothstep(0.08,0.05,abs(Rf.y+0.70));
  win*=1.-smoothstep(0.012,0.0,abs(Rf.x+0.28))*0.8;
  c+=win*0.42+spec;
  float fr=pow(1.-max(dot(n,-dir),0.),4.);
  c=mix(c,vec3(0.97,1.,1.),clamp(fr*0.6+(1.-n.z)*0.5,0.,0.45));
  col=c;
 }

 // Shared signed-distance surface: gel column + basin are a single volume.
 float hit=-1.;int hand=0;
 if(uPullActive.x>0.5)hit=rayGel(uCam,dir,uPullBounds[0],0,ts);
 if(uPullActive.y>0.5){
  float other=rayGel(uCam,dir,uPullBounds[1],1,ts);
  if(other>0.&&(hit<0.||other<hit)){hit=other;hand=1;}
 }
 if(hit>0.){
  vec3 pos=uCam+dir*hit,n=gelNorm(pos,hand);
  vec2 uv=clamp(pos.xy+0.5,vec2(0.),vec2(1.));
  vec3 glitter=texture2D(uG,uv-n.xy*0.032).rgb;
  vec3 lightDir=normalize(vec3(-0.45,-0.55,0.72));
  float lit=0.72+0.32*max(dot(n,lightDir),0.);
  float spec=pow(max(dot(n,normalize(lightDir-dir)),0.),92.)*1.05;
  float fres=pow(1.-max(dot(n,-dir),0.),3.);
  vec3 gel=mix(glitter*vec3(0.52,0.91,0.89),vec3(0.70,0.98,0.94),0.2+0.28*max(n.z,0.));
  col=gel*lit+spec+fres*vec3(0.33,0.57,0.56);
 }
 gl_FragColor=vec4(col,1.);
}`;

  function initGL() {
    gl = glc.getContext('webgl', { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('no webgl');
    const sh = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['uN', 'uG', 'uRes', 'uC', 'uL', 'uR', 'uT', 'uFoc', 'uHZ', 'uCam', 'uF', 'uRt', 'uUp','uPullA[0]','uPullB[0]','uPullBounds[0]','uPullActive']) uni[n] = gl.getUniformLocation(prog, n);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    texN = gl.createTexture(); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texN);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, N, N, 0, gl.RGBA, gl.UNSIGNED_BYTE, nData);
    texG = gl.createTexture(); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texG);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, makeGlitter());
    gl.uniform1i(uni.uN, 0); gl.uniform1i(uni.uG, 1);
  }

  function renderGL(t) {
    buildNormals();
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texN);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, nData);
    gl.viewport(0, 0, glc.width, glc.height);
    gl.uniform2f(uni.uRes, glc.width, glc.height);
    gl.uniform2f(uni.uC, cx * dpr, cy * dpr);
    gl.uniform1f(uni.uL, L * dpr); gl.uniform1f(uni.uR, R); gl.uniform1f(uni.uT, t);
    gl.uniform1f(uni.uFoc, CAM.foc * dpr); gl.uniform1f(uni.uHZ, HZ);
    gl.uniform3fv(uni.uCam, CAM.C); gl.uniform3fv(uni.uF, CAM.f); gl.uniform3fv(uni.uRt, [1, 0, 0]); gl.uniform3fv(uni.uUp, CAM.up);
    uploadGel();
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /* ---------------- 高度场小工具 ---------------- */
  function forDisk(u, v, rad, fn) {
    const cu = u * N, cv = v * N, rc = rad * N * 1.8;
    const i0 = Math.max(1, Math.floor(cu - rc)), i1 = Math.min(N - 2, Math.ceil(cu + rc));
    const j0 = Math.max(1, Math.floor(cv - rc)), j1 = Math.min(N - 2, Math.ceil(cv + rc));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const q = j * N + i; if (!mask[q]) continue;
      fn(q, Math.hypot(i + 0.5 - cu, j + 0.5 - cv) / (rad * N));
    }
  }
  function raiseTo(u, v, rad, amp, k) { forDisk(u, v, rad, (q, d) => { const t = amp * Math.exp(-d * d); if (t > h[q]) h[q] += (t - h[q]) * k; }); }
  function bump(u, v, rad, amp) { forDisk(u, v, rad, (q, d) => { h[q] += amp * Math.exp(-d * d); }); }

  /* ---------------- 泡泡 ---------------- */
  let bubbles = [], sprays = [];
  function addBubble(u, v, r) {
    if (Math.hypot(u - 0.5, v - 0.5) > R - 0.03) return;
    bubbles.push({ u, v, r, ph: Math.random() * 6, grow: 0 });
    if (bubbles.length > 36) bubbles.shift();
  }
  function popBubble(b) {
    forDisk(b.u, b.v, b.r * 1.3, (q, d) => { if (d < 1.6) h[q] -= 0.45 * Math.max(0, 1 - d * d / 2.2); });
    for (let k = 0; k < 9; k++) {
      const a = Math.random() * 6.283, sp = rnd(0.12, 0.32);
      sprays.push({ u: b.u + Math.cos(a) * b.r * 0.6, v: b.v + Math.sin(a) * b.r * 0.6, vu: Math.cos(a) * sp, vv: Math.sin(a) * sp, life: 1, s: rnd(1.2, 3) });
    }
    popBig(b.r);
  }
  function updateBubbles(dt) {
    for (let n = bubbles.length - 1; n >= 0; n--) {
      const b = bubbles[n];
      b.grow = Math.min(1, b.grow + dt * 5);
      let popped = false;
      for (const p of paws.values()) {
        if (p.press < 0.15 || p.grab || p.lifted) continue;
        const dx = b.u - p.u, dy = b.v - p.v, dist = Math.hypot(dx, dy);
        if (p.press > 0.45 && dist < S * 0.62 + b.r) { popped = true; break; }
        const f = sstep(S * 2.2, S * 0.5, dist) * p.press * 0.8;
        b.u += p.du * f; b.v += p.dv * f;
      }
      if (popped) { popBubble(b); bubbles.splice(n, 1); continue; }
      raiseTo(b.u, b.v, b.r * 1.1, 0.32 * Math.min(1.6, b.r / 0.018) * b.grow, 0.3);
    }
    for (let n = sprays.length - 1; n >= 0; n--) {
      const s = sprays[n]; s.u += s.vu * dt; s.v += s.vv * dt; s.vu *= 0.9; s.vv *= 0.9; s.life -= dt * 2.6;
      if (s.life <= 0) sprays.splice(n, 1);
    }
  }
  function drawBubbles(t) {
    for (const b of bubbles) {
      const [x0, y0, kp] = toPx(b.u, b.v), rr = b.r * kp * b.grow * (1 + 0.04 * Math.sin(t * 3 + b.ph));
      if (rr < 1) continue;
      ctx.save(); ctx.translate(x0, y0); ctx.scale(1, SQ); const x = 0, y = 0;
      ctx.fillStyle = 'rgba(255,255,255,0.13)'; ctx.beginPath(); ctx.arc(x, y, rr, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.strokeStyle = 'rgba(70,150,150,0.18)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x + 0.6, y + 0.8, rr, 0.2, 1.8); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)'; ctx.lineWidth = Math.max(1.4, rr * 0.16); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(x, y, rr * 0.66, Math.PI * 1.05, Math.PI * 1.42); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.beginPath(); ctx.arc(x + rr * 0.42, y + rr * 0.42, Math.max(0.8, rr * 0.1), 0, 7); ctx.fill();
      ctx.restore();
    }
    for (const s of sprays) {
      const [x, y] = toPx(s.u, s.v);
      ctx.fillStyle = `rgba(255,255,255,${0.85 * s.life})`; ctx.beginPath(); ctx.arc(x, y, s.s, 0, 7); ctx.fill();
    }
  }


  /* Shared-volume extraction. Height integral in the basin decreases
     by exactly the world volume placed in the raised gel. */
  function radiusAt(t,len){
    const shrink=clamp(Math.sqrt(0.13/Math.max(len,0.13)),0.52,1);
    return S*(0.21*shrink*(1-0.26*Math.sin(Math.PI*t))+
      0.37*Math.exp(-9*t)+0.20*Math.exp(-9*(1-t)));
  }
  function liftedVolume(g){
    if(g.len<=0)return 0;
    let area=0;
    for(let i=0;i<16;i++){const t=(i+0.5)/16,r=radiusAt(t,g.len);area+=r*r;}
    return Math.PI*g.len*area/16;
  }
  function transferVolume(g,next){
    const delta=next-(g.volume||0);
    if(Math.abs(delta)<1e-10){g.volume=next;return;}
    let total=0;
    const radius=S*2.15;
    forDisk(g.au,g.av,radius,(q,d)=>{total+=Math.exp(-2.7*d*d);});
    if(total){
      const correction=delta/(HZ*total/(N*N));
      forDisk(g.au,g.av,radius,(q,d)=>{h[q]-=Math.exp(-2.7*d*d)*correction;});
    }
    g.volume=next;
  }
  function returnGrab(g){returningGel.push(g);}
  function stepReturning(dt){
    for(let k=returningGel.length-1;k>=0;k--){
      const g=returningGel[k],a=Math.min(1,dt*11);
      g.az=hAt(g.au,g.av)*HZ;
      for(const n of g.nodes){
        n.u+=(g.au-n.u)*a;n.v+=(g.av-n.v)*a;n.z+=(g.az-n.z)*a;
      }
      const top=g.nodes[NODES-1];
      g.len=Math.hypot(top.u-g.au,top.v-g.av,top.z-g.az);
      transferVolume(g,liftedVolume(g));
      if(g.len<0.004){
        transferVolume(g,0);
        bump(g.au,g.av,S*0.45,0.06);
        returningGel.splice(k,1);
      }
    }
  }
  function uploadGel(){
    pullA.fill(0);pullB.fill(0);pullBounds.fill(0);pullActive.fill(0);
    const active=[...paws.values()].filter(p=>p.grab).map(p=>p.grab);
    for(const g of returningGel){if(active.length>=2)break;active.push(g);}
    const ids=[0,2,5,8,11,NODES-1];
    for(let hand=0;hand<Math.min(2,active.length);hand++){
      const g=active[hand],v=hand===0?pullA:pullB;
      for(let j=0;j<6;j++){
        const node=g.nodes[ids[j]],i=j*4;
        v[i]=node.u-0.5;v[i+1]=node.v-0.5;v[i+2]=node.z;
        v[i+3]=radiusAt(ids[j]/(NODES-1),g.len);
      }
      const b=g.nodes[0],top=g.nodes[NODES-1],i=hand*4;
      pullBounds[i]=(b.u+top.u)*0.5-0.5;
      pullBounds[i+1]=(b.v+top.v)*0.5-0.5;
      pullBounds[i+2]=(b.z+top.z)*0.5;
      pullBounds[i+3]=Math.hypot(top.u-b.u,top.v-b.v,top.z-b.z)*0.58+S*1.15;
      pullActive[hand]=1;
    }
    gl.uniform4fv(uni['uPullA[0]'],pullA);
    gl.uniform4fv(uni['uPullB[0]'],pullB);
    gl.uniform4fv(uni['uPullBounds[0]'],pullBounds);
    gl.uniform2fv(uni.uPullActive,pullActive);
  }

  /* ---------------- Grab centerline, now part of the 3D material ---------------- */
  let recoils = [];
  const NODES = 14;
  function startGrab(p) {
    const nodes = [];
    const z0 = hAt(p.u, p.v) * HZ;
    for (let i = 0; i < NODES; i++) nodes.push({ u: p.u, v: p.v, z: z0, vu: 0, vv: 0, vz: 0 });
    const [ax, ay] = toPx(p.u, p.v);
    p.grab = { au: p.u, av: p.v, az: z0, ax, ay, nodes, len: 0, volume: 0 }; p.z = z0;
    kyu();
  }
  function strandW(t, len) {
    const W0 = S * 0.62;
    const thin = clamp(Math.sqrt(0.07 / Math.max(len, 0.07)), 0.2, 1);
    const neck = 1 - 0.72 * Math.exp(-(((t - 0.56) / 0.26) ** 2)) * clamp(len / 0.28, 0, 1);
    return W0 * thin * neck + W0 * 0.9 * Math.exp(-t * 7) + W0 * 0.45 * Math.exp(-(1 - t) * 11);
  }
  function updateGrab(p, dt) {
    const g = p.grab;
    const sd = Math.hypot((p.sx - g.ax) * 0.5, Math.min(0, p.sy - g.ay) * 1.0 + Math.max(0, p.sy - g.ay) * 0.4) / L;
    p.z = g.az + 0.015 + sd * 0.75;
    [p.u, p.v] = unproj(p.sx, p.sy, p.z);
    const ax = g.au, ay = g.av, az = g.az, bx = p.u, by = p.v, bz = p.z;
    const len = Math.hypot(bx - ax, by - ay, bz - az);
    const dl = len - g.len; g.len = len;
    const ns = g.nodes;
    for (let i = 0; i < NODES; i++) {
      const t = i / (NODES - 1), n = ns[i];
      const sag = 0.045 * Math.sin(Math.PI * t) * clamp(len / 0.15, 0, 1);
      const tu = ax + (bx - ax) * t, tv = ay + (by - ay) * t, tz = az + (bz - az) * t - sag;
      if (i === 0) { n.u = ax; n.v = ay; n.z = az; continue; }
      if (i === NODES - 1) { n.u = bx; n.v = by; n.z = bz; continue; }
      const kk = 140 + 260 * (1 - Math.sin(Math.PI * t));
      n.vu += ((tu - n.u) * kk - n.vu * 9) * dt; n.vv += ((tv - n.v) * kk - n.vv * 9) * dt; n.vz += ((tz - n.z) * kk * 0.6 - n.vz * 7) * dt;
      n.u += n.vu * dt; n.v += n.vv * dt; n.z = Math.max(az * 0.5, n.z + n.vz * dt);
    }
    transferVolume(g,liftedVolume(g));
    g.az=hAt(ax,ay)*HZ;
    ns[0].z=g.az;
    stretchSound(Math.abs(dl) / Math.max(dt, 1e-3), len);
    aimPaw(p, p.sx);
    if (len > 0.4) snap(p);
  }
  function snap(p) {
    const g = p.grab, len = g.len;
    const mid = g.nodes[NODES >> 1];
    // Physical rupture: detached droplet stays in paw, body flows back.
    returnGrab(g);
    p.grab = null; p.lifted = true; p.blob = true;
    snapSound();
  }
  function retract(p) {
    const g = p.grab;
    returnGrab(g);
    p.grab = null;
    suck();
  }
  function updateRecoils(dt) {
    for (let n = recoils.length - 1; n >= 0; n--) {
      const r = recoils[n]; r.t += dt / r.dur;
      if (r.t >= 1) {
        if (r.end === 'anchor') {
          bump(r.toU, r.toV, S * 0.5, 0.5);
          if (Math.random() < 0.8) addBubble(r.toU + rnd(-0.02, 0.02), r.toV + rnd(-0.02, 0.02), rnd(0.012, 0.022));
          if (Math.random() < 0.5) addBubble(r.toU + rnd(-0.03, 0.03), r.toV + rnd(-0.03, 0.03), rnd(0.008, 0.014));
          plop(0.6);
        }
        recoils.splice(n, 1);
      }
    }
  }
  function catmull(pts, M) {
    const n = pts.length, out = [];
    for (let k = 0; k < M; k++) {
      const f = k / (M - 1) * (n - 1), i = Math.min(n - 2, Math.floor(f)), t = f - i;
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n - 1, i + 2)];
      const q = [];
      for (let c = 0; c < 3; c++) q.push(0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t * t + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t * t * t));
      out.push(q);
    }
    return out;
  }
  const FLAKE = [];
  for (let k = 0; k < 90; k++) FLAKE.push([Math.random(), (Math.random() * 2 - 1) * 0.85, Math.random(), Math.random() * 6.28]);
  const FCOL = ['rgba(120,225,222,0.95)', 'rgba(255,255,255,0.95)', 'rgba(90,205,210,0.9)', 'rgba(185,245,240,0.95)', 'rgba(150,235,255,0.9)'];
  function drawStrandPts(raw, wfn, base) {
    if (raw.length < 2) return;
    const pts = catmull(raw, 40), n = pts.length;
    const T = [], Nn = [], Wd = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1]; const m = Math.hypot(tx, ty) || 1; tx /= m; ty /= m;
      T.push([tx, ty]); Nn.push([-ty, tx]); Wd.push(Math.max(0.6, wfn(i / (n - 1))));
    }
    const path = f => {
      const P = new Path2D();
      for (let i = 0; i < n; i++) P[i ? 'lineTo' : 'moveTo'](pts[i][0] + Nn[i][0] * Wd[i] * f, pts[i][1] + Nn[i][1] * Wd[i] * f);
      for (let i = n - 1; i >= 0; i--) P.lineTo(pts[i][0] - Nn[i][0] * Wd[i] * f, pts[i][1] - Nn[i][1] * Wd[i] * f);
      P.closePath(); return P;
    };
    // 根部和表面融在一起：一圈软软的隆起
    if (base) {
      const [bx, by, bw] = base;
      ctx.save(); ctx.translate(bx, by); ctx.scale(1, SQ);
      const rg = ctx.createRadialGradient(0, 0, bw * 0.2, 0, 0, bw * 2.4);
      rg.addColorStop(0, 'rgba(170,240,235,0.55)'); rg.addColorStop(0.55, 'rgba(150,228,224,0.22)'); rg.addColorStop(1, 'rgba(150,228,224,0)');
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(0, 0, bw * 2.4, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, bw * 1.5, Math.PI * 1.0, Math.PI * 1.55); ctx.stroke();
      ctx.restore();
    }
    // 投在史莱姆上的淡影
    ctx.save(); ctx.translate(5, 8); ctx.fillStyle = 'rgba(30,110,110,0.07)'; ctx.fill(path(1)); ctx.restore();
    // 体积：外圈折射偏深 → 中心透亮
    const layers = [[1.0, 'rgba(60,170,168,0.30)'], [0.86, 'rgba(110,212,206,0.30)'], [0.68, 'rgba(160,236,230,0.26)'], [0.48, 'rgba(205,250,246,0.22)'], [0.26, 'rgba(235,255,253,0.2)']];
    for (const [f, c] of layers) { ctx.fillStyle = c; ctx.fill(path(f)); }
    // 闪粉：被拉长、顺着丝的方向
    ctx.save(); ctx.clip(path(0.95));
    for (let k = 0; k < FLAKE.length; k++) {
      const [ft, fo, fs, fa] = FLAKE[k];
      const i = Math.min(n - 1, Math.round(ft * (n - 1)));
      const w = Wd[i]; if (w < 1.2) continue;
      const x = pts[i][0] + Nn[i][0] * w * fo, y = pts[i][1] + Nn[i][1] * w * fo;
      const sz = (0.7 + fs * 1.6) * clamp(w / 10, 0.5, 1.4);
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.atan2(T[i][1], T[i][0]) + (fa - 3.14) * 0.15);
      ctx.fillStyle = FCOL[k % FCOL.length]; ctx.globalAlpha = 0.55 + 0.45 * (1 - Math.abs(fo));
      ctx.beginPath(); ctx.ellipse(0, 0, sz * 1.8, sz, 0, 0, 7); ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    // 两侧菲涅尔亮边 + 一条锐利高光
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const edge = (f, col, lw) => {
      ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
      for (let i = 0; i < n; i++) { const w = Wd[i] * f; ctx[i ? 'lineTo' : 'moveTo'](pts[i][0] + Nn[i][0] * w, pts[i][1] + Nn[i][1] * w); }
      ctx.stroke();
    };
    const side = Nn[n >> 1][0] < 0 ? 1 : -1; // 光从左上
    edge(0.9 * side, 'rgba(255,255,255,0.55)', 1.3);
    edge(-0.9 * side, 'rgba(255,255,255,0.22)', 1);
    edge(0.45 * side, 'rgba(255,255,255,0.9)', 1.6);
  }
  function drawStrands() {
    for (const p of paws.values()) {
      if (!p.grab) continue;
      const pts = p.grab.nodes.map(n => toPx(n.u, n.v, n.z)), len = p.grab.len;
      drawStrandPts(pts, t => strandW(t, len) * pts[Math.round(t * (pts.length - 1))][2], [pts[0][0], pts[0][1], S * 0.62 * pts[0][2]]);
    }
    for (const r of recoils) {
      const e = 1 - Math.pow(1 - r.t, 3);
      const su = r.fromU + (r.toU - r.fromU) * e, sv = r.fromV + (r.toV - r.fromV) * e, sz = r.fromZ + (r.toZ - r.fromZ) * e;
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const t = i / 7, wig = Math.sin(t * Math.PI * 2 + r.t * 20) * 0.012 * (1 - r.t) * Math.sin(Math.PI * t);
        const u = su + (r.toU - su) * t, v = sv + (r.toV - sv) * t;
        const dx = r.toU - su, dy = r.toV - sv, m = Math.hypot(dx, dy) || 1;
        pts.push(toPx(u - dy / m * wig, v + dx / m * wig, sz + (r.toZ - sz) * t - 0.02 * Math.sin(Math.PI * t) * (1 - r.t)));
      }
      const W0 = S * 0.62 * pts[7][2];
      drawStrandPts(pts, t => W0 * (0.25 + 0.5 * r.t) * (0.4 + 0.6 * t) + W0 * 0.6 * Math.exp(-(1 - t) * 6));
    }
  }

  /* ---------------- 对折 ---------------- */
  let pair = null;
  function checkFold() {
    const ps = [...paws.entries()].filter(([, p]) => p.down && !p.grab && !p.lifted && p.press > 0.5);
    if (ps.length < 2) { pair = null; return; }
    const [[ia, a], [ib, b]] = ps;
    const dist = Math.hypot(a.u - b.u, a.v - b.v);
    if (!pair || pair.a !== ia || pair.b !== ib) { pair = { a: ia, b: ib, d0: dist, done: false }; return; }
    pair.d0 = Math.max(pair.d0, dist);
    if (!pair.done && pair.d0 - dist > 0.15 && dist < S * 3.4) { pair.done = true; fold(a, b); }
  }
  function fold(a, b) {
    const mu = (a.u + b.u) / 2, mv = (a.v + b.v) / 2;
    let ux = b.u - a.u, uy = b.v - a.v; const m = Math.hypot(ux, uy) || 1; ux /= m; uy /= m;
    const px = -uy, py = ux;
    for (let t = -1; t <= 1.001; t += 0.1) bump(mu + px * t * 0.17, mv + py * t * 0.17, S * 0.42, 0.14 * (1 - 0.5 * t * t));
    const nb = 4 + ((Math.random() * 3) | 0);
    for (let k = 0; k < nb; k++) {
      const t = rnd(-0.9, 0.9);
      addBubble(mu + px * t * 0.16 + ux * rnd(-0.015, 0.015), mv + py * t * 0.16 + uy * rnd(-0.015, 0.015), rnd(0.01, 0.026));
    }
    for (const d of decos) {
      const dx = d.u - mu, dy = d.v - mv, dist = Math.hypot(dx, dy);
      if (dist < 0.2) { const s2 = (dx * px + dy * py) >= 0 ? 1 : -1; d.u += px * s2 * 0.02 / d.m; d.v += py * s2 * 0.02 / d.m; d.va += rnd(-0.05, 0.05); }
    }
    foldSound();
  }

  /* ---------------- 毛茸茸猫爪精灵 ---------------- */
  let pawSpr = null, pawSprC = null;
  function makePawSprite(curled) {
    const P = 64, Wd = Math.round(P * 2.8), Ht = Math.round(P * 5.2), ox = Wd / 2, oy = Math.round(P * 1.3);
    const c = document.createElement('canvas'); c.width = Wd; c.height = Ht;
    const g = c.getContext('2d');
    const tk = curled ? 0.8 : 1, tr = curled ? 0.9 : 1;
    const toes = [[-0.64, -0.5, 0.32], [-0.23, -0.84, 0.35], [0.23, -0.84, 0.35], [0.64, -0.5, 0.32]]
      .map(([x, y, r]) => [x * P * tk, y * P * tk, r * P * tr]);
    const sd = (x, y) => {
      let d = (Math.hypot(x / (0.9 * P), y / (0.84 * P)) - 1) * 0.84 * P;
      for (const [tx, ty, r] of toes) d = smin(d, Math.hypot(x - tx, y - ty) - r, 0.05 * P);
      const w = 0.56 * P * (1 + 0.07 * Math.max(0, y - 0.6 * P) / P);
      const da = y < 0.5 * P ? Math.hypot(x, y - 0.5 * P) - w : Math.abs(x) - w;
      return smin(d, da, 0.25 * P);
    };
    const tabby = (x, y) => y > 0.55 * P && Math.sin((y / P) * 5.2 + Math.sin(x / P * 2) * 0.6) > 0.55;
    // 底色（逐像素，带体积明暗）
    const img = g.createImageData(Wd, Ht), D = img.data;
    for (let y = 0; y < Ht; y++) for (let x = 0; x < Wd; x++) {
      const lx = x - ox, ly = y - oy, d = sd(lx, ly);
      if (d > 0.5) continue;
      const o = (y * Wd + x) * 4;
      const edge = clamp(1 + d / (0.32 * P), 0, 1);
      const hl = Math.exp(-((lx + 0.35 * P) ** 2 + (ly + 0.25 * P) ** 2) / (0.55 * P) ** 2);
      let r = 236, gg = 232, b = 241;
      if (tabby(lx, ly)) { r = 205; gg = 198; b = 214; }
      const sh = 1 - 0.13 * edge * edge + 0.05 * hl;
      D[o] = r * sh; D[o + 1] = gg * sh; D[o + 2] = b * sh; D[o + 3] = 255 * clamp(0.5 - d, 0, 1);
    }
    g.putImageData(img, 0, 0);
    // 毛
    g.lineCap = 'round';
    const grad = (x, y) => { const e = 1; return [(sd(x + e, y) - sd(x - e, y)) / 2, (sd(x, y + e) - sd(x, y - e)) / 2]; };
    for (let k = 0; k < 9000; k++) {
      const lx = rnd(-1.4, 1.4) * P, ly = rnd(-1.25, 3.9) * P;
      const d = sd(lx, ly); if (d > 0.01 * P) continue;
      let [nx, ny] = grad(lx, ly); const nm = Math.hypot(nx, ny) || 1; nx /= nm; ny /= nm;
      const e = clamp(1 + d / (0.2 * P), 0, 1);
      const ja = rnd(-0.5, 0.5);
      let fx = Math.sin(ja), fy = -Math.cos(ja);
      fx = fx * (1 - e * 0.85) + nx * e * 0.85; fy = fy * (1 - e * 0.85) + ny * e * 0.85;
      const fm = Math.hypot(fx, fy) || 1; fx /= fm; fy /= fm;
      const nearToe = ly < -0.3 * P ? 0.55 : 1;
      const len = P * rnd(0.05, 0.11) * (1 + e * 0.7 * nearToe);
      const sx = lx - fx * len * 0.35, sy = ly - fy * len * 0.35;
      let r = 238, gg = 234, b = 243;
      if (tabby(lx, ly)) { r = 196; gg = 189; b = 207; }
      const shade = (1 - 0.14 * e) * (1 + 0.05 * Math.exp(-((lx + 0.35 * P) ** 2 + (ly + 0.25 * P) ** 2) / (0.6 * P) ** 2)) * rnd(0.93, 1.05);
      g.strokeStyle = `rgba(${clamp(r * shade, 0, 255) | 0},${clamp(gg * shade, 0, 255) | 0},${clamp(b * shade, 0, 255) | 0},0.85)`;
      g.lineWidth = rnd(0.9, 1.6);
      g.beginPath(); g.moveTo(ox + sx, oy + sy); g.quadraticCurveTo(ox + sx + fx * len * 0.5 + fy * len * 0.12, oy + sy + fy * len * 0.5 - fx * len * 0.12, ox + sx + fx * len, oy + sy + fy * len); g.stroke();
    }
    // 高光毛
    for (let k = 0; k < 1400; k++) {
      const lx = rnd(-1, 0.4) * P, ly = rnd(-1.1, 0.6) * P;
      if (sd(lx, ly) > -0.05 * P) continue;
      const len = P * rnd(0.05, 0.1), ja = rnd(-0.4, 0.4);
      g.strokeStyle = 'rgba(255,255,255,0.6)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(ox + lx, oy + ly); g.lineTo(ox + lx + Math.sin(ja) * len, oy + ly - Math.cos(ja) * len); g.stroke();
    }
    // 脚趾缝：一道柔和的阴影沟 + 几根深色毛
    for (let k = 0; k < 3; k++) {
      const a = toes[k], b = toes[k + 1], mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
      const ex = mx * 0.55, ey = my + 0.42 * P;
      g.strokeStyle = 'rgba(140,128,158,0.32)'; g.lineWidth = 0.13 * P; g.lineCap = 'round';
      g.beginPath(); g.moveTo(ox + mx * 1.04, oy + my - 0.12 * P); g.quadraticCurveTo(ox + mx * 0.9, oy + my + 0.15 * P, ox + ex, oy + ey); g.stroke();
      g.strokeStyle = 'rgba(125,112,145,0.6)'; g.lineWidth = 1.5;
      for (let s = 0; s < 7; s++) {
        const t = s / 6, x = mx * (1.02 - t * 0.47), y = my - 0.1 * P + t * 0.5 * P;
        g.beginPath(); g.moveTo(ox + x + rnd(-1, 1), oy + y); g.lineTo(ox + x + rnd(-2, 2), oy + y + 0.08 * P); g.stroke();
      }
    }
    // 每颗脚趾顶上一点亮
    for (const [tx, ty, r] of toes) {
      const rg = g.createRadialGradient(ox + tx - r * 0.25, oy + ty - r * 0.3, 0, ox + tx, oy + ty, r * 1.05);
      rg.addColorStop(0, 'rgba(255,255,255,0.35)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.beginPath(); g.arc(ox + tx, oy + ty, r * 1.05, 0, 7); g.fill();
    }
    // 整体明暗
    g.globalCompositeOperation = 'source-atop';
    const lg = g.createLinearGradient(ox - P, oy - P, ox + P, oy + P * 1.5);
    lg.addColorStop(0, 'rgba(255,255,255,0.18)'); lg.addColorStop(0.5, 'rgba(255,255,255,0)'); lg.addColorStop(1, 'rgba(90,75,115,0.16)');
    g.fillStyle = lg; g.fillRect(0, 0, Wd, Ht);
    // 手臂往后渐隐（像从镜头外伸进来）
    g.globalCompositeOperation = 'destination-in';
    const fg = g.createLinearGradient(0, oy + 1.5 * P, 0, oy + 3.8 * P);
    fg.addColorStop(0, 'rgba(0,0,0,1)'); fg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = fg; g.fillRect(0, 0, Wd, Ht);
    g.globalCompositeOperation = 'source-over';
    return { c, ox, oy, P };
  }

  /* ---------------- 叠加层 ---------------- */
  const HZ = 0.026, EL = 52 * Math.PI / 180, CD = 1.7, SQ = Math.sin(EL);
  const CAM = { C: [0, CD * Math.cos(EL), CD * Math.sin(EL)], f: [0, -Math.cos(EL), -Math.sin(EL)], up: [0, -Math.sin(EL), Math.cos(EL)], foc: 400 };
  function proj(x, y, z) {
    const dx = x - CAM.C[0], dy = y - CAM.C[1], dz = z - CAM.C[2];
    const zz = dx * CAM.f[0] + dy * CAM.f[1] + dz * CAM.f[2];
    return [cx + CAM.foc * dx / zz, cy - CAM.foc * (dy * CAM.up[1] + dz * CAM.up[2]) / zz, CAM.foc / zz];
  }
  function unproj(x, y, z0) {
    const a = x - cx, b = y - cy;
    const d = [CAM.f[0] * CAM.foc + a, CAM.f[1] * CAM.foc - CAM.up[1] * b, CAM.f[2] * CAM.foc - CAM.up[2] * b];
    const t = (z0 - CAM.C[2]) / d[2];
    return [CAM.C[0] + d[0] * t + 0.5, CAM.C[1] + d[1] * t + 0.5];
  }
  const toPx = (u, v, z) => proj(u - 0.5, v - 0.5, z === undefined ? hAt(u, v) * HZ : z);

  function drawDecos() {
    for (const d of decos) {
      const [x, y, kp] = toPx(d.u, d.v);
      const hh = hAt(d.u, d.v), [gx, gy] = gradAt(d.u, d.v);
      const gm = Math.hypot(gx, gy), ga = Math.atan2(gy, gx);
      const sc = (1 + 0.07 * hh) * (1 - 0.07 * d.sink) * (1 + 0.9 * d.drop);
      const sz = d.size * kp * sc * d.img.k;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, Math.min(1, SQ + 0.08));
      ctx.rotate(ga); ctx.scale(1 - clamp(gm * 0.35, 0, 0.3), 1); ctx.rotate(-ga);
      ctx.rotate(d.a);
      ctx.globalAlpha = clamp(1 + hh * 0.18 - d.sink * 0.12, 0.6, 1) * (1 - clamp(d.drop, 0, 1) * 0.7);
      ctx.drawImage(d.img, -sz / 2, -sz / 2, sz, sz);
      ctx.restore();
    }
  }

  function drawPaw(p) {
    const up = p.grab || p.lifted;
    const [x, y, kp] = toPx(p.u, p.v, up ? p.z : HZ * Math.max(0, hAt(p.u, p.v)) + 0.012 * (1 - p.press));
    const [gx, gy] = toPx(p.u, p.v);
    const spr = p.grab ? pawSprC : pawSpr;
    const Ppx = S * kp * 1.04;
    const sc = Ppx / spr.P * (1 - 0.06 * p.press);
    const back = p.out * Ppx * 3.4;
    const px = x - p.fx * back, py = y - p.fy * back;
    ctx.save();
    ctx.globalAlpha = 1 - p.out;
    const lift = up ? clamp((p.z || 0) / 0.2, 0, 1) : 0;
    const so = Ppx * (0.3 - 0.22 * p.press + 0.6 * lift);
    ctx.fillStyle = `rgba(30,80,85,${(0.14 + 0.1 * p.press) * (1 - 0.5 * lift)})`;
    ctx.beginPath(); ctx.ellipse(gx + so * 0.6 - p.fx * back, gy + so * 0.5 - p.fy * back, Ppx * (1 + lift * 0.4), Ppx * SQ * (1 + lift * 0.4), 0, 0, 7); ctx.fill();
    ctx.translate(px, py); ctx.rotate(Math.atan2(p.fx, -p.fy)); ctx.scale(sc, sc * 0.88);
    ctx.drawImage(spr.c, -spr.ox, -spr.oy);
    if (p.blob) { // 爪子里攥着一小团史莱姆
      ctx.fillStyle = 'rgba(150,228,222,0.75)'; ctx.beginPath(); ctx.ellipse(0, -spr.P * 0.95, spr.P * 0.42, spr.P * 0.26, 0, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; ctx.beginPath(); ctx.ellipse(-spr.P * 0.15, -spr.P * 1.02, spr.P * 0.1, spr.P * 0.05, -0.3, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  function drawOverlay(t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawBubbles(t);
    drawDecos();
    // The gel column is inside the WebGL material, not drawn as a Canvas sprite.
    for (const p of paws.values()) drawPaw(p);
  }

  /* ---------------- 声音 ---------------- */
  let AC = null, master, noiseBuf, dragGain, dragBP;
  function audioInit() {
    if (AC) { if (AC.state === 'suspended') AC.resume(); return; }
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
      master = AC.createGain(); master.gain.value = muted ? 0 : 0.9; master.connect(AC.destination);
      noiseBuf = AC.createBuffer(1, AC.sampleRate * 2, AC.sampleRate);
      const dd = noiseBuf.getChannelData(0); let b = 0;
      for (let i = 0; i < dd.length; i++) { b = b * 0.6 + (Math.random() * 2 - 1) * 0.4; dd[i] = b * 1.8; }
      const src = AC.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
      dragBP = AC.createBiquadFilter(); dragBP.type = 'bandpass'; dragBP.frequency.value = 800; dragBP.Q.value = 2.2;
      dragGain = AC.createGain(); dragGain.gain.value = 0;
      src.connect(dragBP); dragBP.connect(dragGain); dragGain.connect(master); src.start();
    } catch (e) { AC = null; }
  }
  function nz(t, dur) { const s = AC.createBufferSource(); s.buffer = noiseBuf; s.start(t, Math.random() * 1.5, dur + 0.05); return s; }
  function squish(str) {
    if (!AC) return; const t = AC.currentTime;
    const s = nz(t, 0.3), bp = AC.createBiquadFilter(), g = AC.createGain();
    bp.type = 'bandpass'; bp.Q.value = 3; bp.frequency.setValueAtTime(700 + Math.random() * 300, t); bp.frequency.exponentialRampToValueAtTime(220, t + 0.22);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.5 * str, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    s.connect(bp); bp.connect(g); g.connect(master);
    const o = AC.createOscillator(), og = AC.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.16);
    og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.28 * str, t + 0.015); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(og); og.connect(master); o.start(t); o.stop(t + 0.2);
  }
  function pop(v) {
    if (!AC) return; const t = AC.currentTime;
    const o = AC.createOscillator(), g = AC.createGain(), f = 700 + Math.random() * 1500;
    o.frequency.setValueAtTime(f, t); o.frequency.exponentialRampToValueAtTime(f * 1.9, t + 0.035);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07 * v, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + 0.06);
  }
  function suck() {
    if (!AC) return; const t = AC.currentTime;
    const s = nz(t, 0.12), hp = AC.createBiquadFilter(), g = AC.createGain();
    hp.type = 'highpass'; hp.frequency.value = 1400;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.16, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    s.connect(hp); hp.connect(g); g.connect(master);
    const o = AC.createOscillator(), og = AC.createGain();
    o.frequency.setValueAtTime(260, t); o.frequency.exponentialRampToValueAtTime(760, t + 0.07);
    og.gain.setValueAtTime(0.0001, t); og.gain.exponentialRampToValueAtTime(0.12, t + 0.01); og.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(og); og.connect(master); o.start(t); o.stop(t + 0.1);
  }
  function dragSound(speed) {
    if (!AC) return; const t = AC.currentTime;
    dragGain.gain.setTargetAtTime(Math.min(0.32, speed * 0.55), t, 0.04);
    dragBP.frequency.setTargetAtTime(450 + Math.min(speed, 1.5) * 900 + Math.random() * 250, t, 0.05);
    if (speed > 0.08 && Math.random() < Math.min(0.35, speed * 0.25)) pop(Math.min(1, 0.4 + speed));
  }

  function tone(f0, f1, dur, vol, type) {
    if (!AC) return; const t = AC.currentTime;
    const o = AC.createOscillator(), g = AC.createGain(); o.type = type || 'sine';
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.012, dur * 0.3)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
  }
  function burst(type, freq, q, dur, vol) {
    if (!AC) return; const t = AC.currentTime;
    const s = nz(t, dur), f = AC.createBiquadFilter(), g = AC.createGain();
    f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(g); g.connect(master);
  }
  function kyu() { tone(420, 900, 0.07, 0.08); burst('bandpass', 1800, 3, 0.05, 0.05); }
  function popBig(r) { const f = 900 - Math.min(r, 0.03) * 12000; tone(Math.max(380, f), Math.max(380, f) * 2.2, 0.05, 0.16); burst('highpass', 2500, 0.7, 0.04, 0.12); }
  function snapSound() { burst('highpass', 1800, 0.8, 0.06, 0.2); tone(700, 1500, 0.05, 0.1); setTimeout(() => tone(260, 120, 0.12, 0.12), 40); }
  function plop(v) { tone(220, 90, 0.13, 0.18 * v); burst('lowpass', 500, 1, 0.12, 0.18 * v); }
  function crunch() { burst('highpass', 3000 + Math.random() * 2500, 1, 0.025, 0.09); }
  function foldSound() { squish(1.2); for (let k = 0; k < 5; k++) setTimeout(() => pop(0.8), 60 + k * 45 + Math.random() * 30); }
  function sprinkleSound(n) { for (let k = 0; k < Math.min(n, 10); k++) setTimeout(() => tone(2400 + Math.random() * 1800, 3200 + Math.random() * 1500, 0.03, 0.03), k * 35 + Math.random() * 20); }
  let stretchAcc = 0;
  function stretchSound(speed, len) {
    if (!AC) return; const t = AC.currentTime;
    dragGain.gain.setTargetAtTime(Math.min(0.18, speed * 0.25), t, 0.05);
    dragBP.frequency.setTargetAtTime(500 + len * 2200, t, 0.05);
    stretchAcc += speed * 0.016;
    if (stretchAcc > 0.05) { stretchAcc = 0; if (Math.random() < 0.6) pop(0.5); }
  }

  /* ---------------- 输入 ---------------- */
  function toUV(e) {
    const rc = ov.getBoundingClientRect();
    const x = e.clientX - rc.left, y = e.clientY - rc.top;
    const [u, v] = unproj(x, y, 0);
    return [u, v, x, y];
  }
  function aimPaw(p, x) {
    let side = x < W / 2 ? -1 : 1;
    const others = [...paws.values()].filter(q => q !== p && q.out < 0.5);
    if (others.length) side = x < toPx(others[0].u, others[0].v)[0] ? -1 : 1;
    p.rootX = x + side * L * (p.grab || p.lifted ? 0.75 : 0.16);
    const [px, py] = toPx(p.u, p.v);
    const dx = px - p.rootX, dy = py - (H + S * L * 2);
    const m = Math.hypot(dx, dy) || 1; p.fx = dx / m; p.fy = dy / m;
  }
  let interactions = 0;
  function onDown(e) {
    e.preventDefault();
    audioInit();
    try { ov.setPointerCapture(e.pointerId); } catch (_) {}
    const [u, v, x] = toUV(e);
    let p = paws.get(e.pointerId);
    if (!p) { p = { u, v, press: 0, out: 1, du: 0, dv: 0, fx: 0, fy: -1, rootX: x }; paws.set(e.pointerId, p); }
    p.sx = x; p.sy = toUV(e)[3];
    Object.assign(p, { u, v, down: true, leaving: false, mouse: e.pointerType === 'mouse', du: 0, dv: 0, pu: 0, pv: 0,
      u0: u, v0: v, holdT: 0, downT: 0, grab: null, lifted: false, blob: false });
    aimPaw(p, x);
    if (Math.hypot(u - 0.5, v - 0.5) < R) { squish(0.9); if (navigator.vibrate) navigator.vibrate(8); }
    if (++interactions > 6) hideHint();
  }
  function onMove(e) {
    const [u, v, x] = toUV(e);
    let p = paws.get(e.pointerId);
    if (!p) {
      if (e.pointerType !== 'mouse') return;
      p = { u, v, press: 0, down: false, out: 1, du: 0, dv: 0, fx: 0, fy: -1, rootX: x, mouse: true }; paws.set(e.pointerId, p);
    }
    p.leaving = false;
    p.sx = x; p.sy = toUV(e)[3];
    if (p.grab) return;
    if (p.lifted) { [p.u, p.v] = unproj(x, p.sy, p.z); aimPaw(p, x); return; }
    p.pu = (p.pu || 0) + (u - p.u); p.pv = (p.pv || 0) + (v - p.v);
    p.u = u; p.v = v;
    aimPaw(p, x);
    if (p.down) e.preventDefault();
  }
  function onUp(e) {
    const p = paws.get(e.pointerId); if (!p) return;
    const inTub = Math.hypot(p.u - 0.5, p.v - 0.5) < R;
    if (p.grab) retract(p);
    else if (p.lifted) {
      if (p.blob && inTub) { bump(p.u, p.v, S * 0.65, 0.75); plop(1); if (Math.random() < 0.6) addBubble(p.u + rnd(-0.02, 0.02), p.v + rnd(-0.02, 0.02), rnd(0.01, 0.018)); }
    } else if (p.down && p.press > 0.3 && inTub) {
      suck();
      if (p.downT > 0.1 && Math.random() < 0.3) addBubble(p.u + p.fx * S * 0.4 + rnd(-0.01, 0.01), p.v + p.fy * S * 0.4 + rnd(-0.01, 0.01), rnd(0.009, 0.017));
    }
    p.down = false; p.lifted = false; p.blob = false;
    if (e.pointerType !== 'mouse' || e.type === 'pointercancel') p.leaving = true;
  }
  function onLeave(e) { const p = paws.get(e.pointerId); if (p && e.pointerType === 'mouse') { if (p.grab) retract(p); p.down = false; p.leaving = true; } }

  /* ---------------- 主循环 ---------------- */
  function step(dt) {
    let speed = 0;
    for (const [id, p] of paws) {
      const du = p.pu || 0, dv = p.pv || 0; p.pu = 0; p.pv = 0;
      p.du = du; p.dv = dv;
      const inTub = Math.hypot(p.u - 0.5, p.v - 0.5) < R + 0.01;
      if (p.down) {
        p.downT += dt;
        if (!p.grab && !p.lifted) {
          if (Math.hypot(p.u - p.u0, p.v - p.v0) < 0.018) p.holdT += dt; else p.holdT = -1e9;
          if (p.holdT > 0.33 && inTub) startGrab(p);
        }
      }
      const target = p.down && inTub && !p.grab && !p.lifted ? 1 : 0;
      p.press += (target - p.press) * Math.min(1, dt * (target ? 11 : 9));
      p.out += ((p.leaving ? 1 : 0) - p.out) * Math.min(1, dt * (p.leaving ? 7 : 14));
      if (p.grab) updateGrab(p, dt);
      else if (p.press > 0.05 && !p.lifted) {
        if (du || dv) smear(p, du, dv);
        speed += Math.hypot(du, dv) / Math.max(dt, 1e-3) * p.press;
      }
      if (p.leaving && p.out > 0.97 && p.press < 0.02) paws.delete(id);
    }
    diffuse();
    for (const p of paws.values()) stamp(p);
    checkFold();
    updateBubbles(dt);
    stepReturning(dt);
    updateDecos(dt);
    if (![...paws.values()].some(p => p.grab)) dragSound(speed);
  }

  function frame(t) {
    requestAnimationFrame(frame);
    const dt = last ? Math.min(0.05, (t - last) / 1000) : 0.016; last = t;
    step(dt);
    renderGL(t / 1000);
    drawOverlay(t / 1000);
  }

  function resize() {
    const rc = root.getBoundingClientRect();
    W = rc.width; H = rc.height; dpr = Math.min(2, window.devicePixelRatio || 1);
    L = Math.min(W * 0.95, H * 0.66) / (2 * R + 0.05);
    cx = W / 2; cy = H * 0.5; CAM.foc = L * CD;
    for (const c of [glc, ov]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.width = W + 'px'; c.style.height = H + 'px'; }
  }

  /* ---------------- UI ---------------- */
  let hintEl;
  function hideHint() { if (hintEl) { hintEl.style.opacity = '0'; } }
  function ui() {
    const css = document.createElement('style');
    css.textContent = `
.slm-root{position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;background:#EEEEF1}
.slm-root canvas{position:absolute;left:0;top:0;display:block}
.slm-ov{touch-action:none;cursor:none}
.slm-title{position:absolute;left:18px;top:16px;font:700 18px/1.2 "PingFang SC","Hiragino Sans GB",system-ui,sans-serif;color:#3f8f8c;letter-spacing:1px;pointer-events:none}
.slm-title small{display:block;font-weight:500;font-size:12px;color:#7fb8b5;margin-top:3px;letter-spacing:0}
.slm-btns{position:absolute;right:14px;top:14px;display:flex;gap:8px;z-index:3}
.slm-btn{border:0;border-radius:999px;min-height:44px;padding:8px 14px;background:rgba(255,255,255,.85);color:#3f8f8c;font:600 14px "PingFang SC",system-ui,sans-serif;box-shadow:0 2px 10px rgba(60,120,120,.15);cursor:pointer;-webkit-tap-highlight-color:transparent}
.slm-btn:active{transform:scale(.94)}
.slm-tools{position:absolute;left:0;right:0;bottom:calc(18px + env(safe-area-inset-bottom));display:flex;justify-content:center;gap:10px;z-index:3}
.slm-hint{position:absolute;left:12px;right:12px;bottom:calc(76px + env(safe-area-inset-bottom));text-align:center;font:500 13px/1.6 "PingFang SC",system-ui,sans-serif;color:#5aa6a2;pointer-events:none;transition:opacity 1s}`;
    document.head.appendChild(css);
    const t = document.createElement('div'); t.className = 'slm-title'; t.innerHTML = '小海捏捏 ฅ<small>薄荷闪粉史莱姆</small>'; root.appendChild(t);
    const stop = b => { b.addEventListener('pointerdown', e => e.stopPropagation()); return b; };
    const btn = (txt, fn) => { const b = document.createElement('button'); b.className = 'slm-btn'; b.textContent = txt; b.onclick = () => { audioInit(); fn(b); }; return stop(b); };
    const bs = document.createElement('div'); bs.className = 'slm-btns';
    bs.appendChild(btn('🔊', b => { muted = !muted; b.textContent = muted ? '🔇' : '🔊'; if (master) master.gain.value = muted ? 0 : 0.9; }));
    bs.appendChild(btn('↺ 抚平', () => { for (const d of decos) d.home = 1.2; flatten = 1; bubbles.length = 0; }));
    root.appendChild(bs);
    const tl = document.createElement('div'); tl.className = 'slm-tools';
    tl.appendChild(btn('＋ 泡沫珠', () => addToppings('bead')));
    tl.appendChild(btn('＋ 亮片', () => addToppings('seq')));
    tl.appendChild(btn('🫧 吹泡泡', () => { for (let k = 0; k < 5; k++) { const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * (R - 0.06); addBubble(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, rnd(0.01, 0.026)); } tone(500, 300, 0.12, 0.06); }));
    root.appendChild(tl);
    hintEl = document.createElement('div'); hintEl.className = 'slm-hint';
    hintEl.innerHTML = '按住不动一下再拖＝拉丝　两只爪往中间合拢＝对折<br>戳泡泡会啵～　一根手指一只爪，两根手指两只爪';
    root.appendChild(hintEl);
  }
  let flatten = 0;

  function init(el) {
    root = el; root.classList.add('slm-root');
    glc = document.createElement('canvas'); ov = document.createElement('canvas'); ov.className = 'slm-ov';
    root.appendChild(glc); root.appendChild(ov);
    initField(); makeDecos(); ui(); resize();
    pawSpr = makePawSprite(false); pawSprC = makePawSprite(true);
    for (let k = 0; k < 5; k++) { const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * (R - 0.08); addBubble(0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r, rnd(0.01, 0.022)); }
    try { initGL(); } catch (err) {
      const m = document.createElement('div'); m.style.cssText = 'position:absolute;left:10px;top:60px;color:#c33;font:12px monospace;white-space:pre-wrap;z-index:9';
      m.textContent = 'WebGL 出错: ' + err.message; root.appendChild(m); return;
    }
    ctx = ov.getContext('2d');
    ov.addEventListener('pointerdown', onDown, { passive: false });
    ov.addEventListener('pointermove', onMove, { passive: false });
    ov.addEventListener('pointerup', onUp); ov.addEventListener('pointercancel', onUp);
    ov.addEventListener('pointerleave', onLeave);
    ov.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    ov.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('resize', resize);
    requestAnimationFrame(frame);
    setInterval(() => { if (flatten > 0) { for (let i = 0; i < h.length; i++) h[i] *= 0.82; flatten -= 0.1; } }, 50);
  }

  window.Slime = { init, _test: { initField, stamp, diffuse, smear, get h() { return h; }, N, S, R,
    radiusAt, liftedVolume, transferVolume, get returningGel(){return returningGel;},
    makePawSprite, makeDecos, step, initPaws() { pawSpr = makePawSprite(false); pawSprC = makePawSprite(true); },
    debugDraw(c2d, w, hh) { ctx = c2d; W = w; H = hh; dpr = 1; L = Math.min(W * 0.95, H * 0.66) / (2 * R + 0.05); cx = W / 2; cy = H * 0.5; CAM.foc = L * CD; drawOverlay(0); }, proj: (...a) => proj(...a), unproj: (...a) => unproj(...a), get decos() { return decos; }, startGrab, updateGrab, fold, addBubble, updateBubbles, get bubbles() { return bubbles; }, paws } };
})();
