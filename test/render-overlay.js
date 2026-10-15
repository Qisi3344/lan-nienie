const C=require('@napi-rs/canvas');
global.window={};global.Path2D=C.Path2D;global.document={createElement:()=>C.createCanvas(1,1)};
require('../src/slime.js');const T=window.Slime._test;
T.initField();T.makeDecos();T.initPaws();
const W=390,H=760,cv=C.createCanvas(W,H),g=cv.getContext('2d');T.debugDraw(g,W,H);
const P=T.paws;
function mk(id,x,y){const [u,v]=T.unproj(x,y,0);const p={u,v,sx:x,sy:y,press:0,out:0,du:0,dv:0,pu:0,pv:0,fx:0,fy:-1,rootX:x+40,down:true,u0:u,v0:v,holdT:-1e9,downT:0,grab:null,lifted:false,blob:false};
 const dx=x-p.rootX,dy=y-(H+40);const m=Math.hypot(dx,dy);p.fx=dx/m;p.fy=dy/m;P.set(id,p);return p;}
const a=mk(1,140,330);for(let f=0;f<30;f++)T.step(1/60);
const b=mk(2,250,430);b.holdT=0;for(let f=0;f<25;f++)T.step(1/60);
const steps=+process.argv[2]||40;
for(let f=0;f<steps;f++){b.sy-=3;b.sx+=0.5;T.step(1/60);}
console.log('grab',!!b.grab,'lifted',b.lifted,'z',b.z&&b.z.toFixed(3),'len',b.grab&&b.grab.len.toFixed(3));
T.addBubble(0.45,0.6,0.02);for(let f=0;f<5;f++)T.step(1/60);
T.debugDraw(g,W,H);
const out=C.createCanvas(W,H),o=out.getContext('2d');o.fillStyle='#a5dcd8';o.beginPath();
// draw tub outline ellipse approx via projection
for(let k=0;k<=64;k++){const an=k/64*6.283;const [x,y]=T.proj(Math.cos(an)*0.47,Math.sin(an)*0.47,0);k?o.lineTo(x,y):o.moveTo(x,y);}o.fill();
o.drawImage(cv,0,0);require('fs').writeFileSync('ov3.png',out.toBuffer('image/png'));
