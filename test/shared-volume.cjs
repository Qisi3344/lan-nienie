'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/slime.js'), 'utf8');
new vm.Script(source);  // catches syntax errors without creating DOM
assert(!/^[ \t]*drawStrands\(\);/m.test(source), 'Canvas-only fake gel strand is still in drawOverlay');
assert(source.includes('unifiedGel('), 'raised gel must join the WebGL basin SDF');
const context = { window: {}, document: {} };
vm.runInNewContext(source, context);
const t = context.window.Slime._test;
const heightIntegral = () => t.h.reduce((sum, height) => sum + height, 0) * 0.026 / (t.N * t.N);
for (const [u,v,len] of [[0.5,0.5,0.12],[0.41,0.57,0.28],[0.65,0.35,0.4]]) {
  t.initField();
  const g = { au: u, av: v, len, volume: 0 };
  const before = heightIntegral();
  const lifted = t.liftedVolume(g);
  assert(lifted > 0);
  t.transferVolume(g, lifted);
  assert(Math.abs(heightIntegral() + g.volume - before) < 1e-7, 'pull must remove the same volume from the basin');
  t.transferVolume(g, 0);
  assert(Math.abs(heightIntegral() - before) < 1e-7, 'release must return that volume');
}
console.log('shared volume: JS syntax, joined WebGL surface, extraction and return PASS');
