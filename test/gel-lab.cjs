'use strict';
const assert=require('node:assert/strict');
const {Gel}=require('../experiments/gel-lab/physics.js');
const gel=new Gel();
const ids=gel.particles.map(p=>p.id),count=ids.length;
assert(count>150&&count<300,'expected bounded mobile particle count');
for(let i=0;i<120;i++)gel.step(1/60);
const pulled=gel.particles.reduce((a,b)=>b.y<a.y?b:a);
const baseY=pulled.y;
assert(gel.beginGrab('finger',pulled.x,pulled.y),'real material must be selectable');
for(let i=0;i<52;i++){
 gel.moveGrab('finger',pulled.x,baseY-3*i);
 gel.step(1/60);
}
assert(pulled.y<baseY-50,'selected MATERIAL particle must rise with grab');
assert.equal(gel.particles.length,count,'must not create a fake strand of extra material');
gel.endGrab('finger');
for(let i=0;i<140;i++)gel.step(1/60);
assert(pulled.y>baseY-40,'physical pulled material should return under cohesion and gravity');
assert.equal(gel.grabs.size,0);
assert.deepEqual(gel.particles.map(p=>p.id),ids,'original material IDs must remain identical');
assert(gel.bonds.size>0,'cohesive spring network exists');
for(const p of gel.particles){
 assert(Number.isFinite(p.x+p.y+p.vx+p.vy),'no NaN/Infinity');
 assert(p.x>=gel.left+4.99&&p.x<=gel.right-4.99,'tray x bounds');
 assert(p.y>=19.99&&p.y<=gel.floor-3.99,'tray y bounds');
}
console.log('2D slime material test PASS',JSON.stringify(gel.metrics()));
