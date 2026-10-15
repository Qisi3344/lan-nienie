(function(){
 'use strict';
 const canvas=document.getElementById('gel'),ctx=canvas.getContext('2d',{alpha:false});
 const W=640,H=520,sim=new GelPhysics.Gel();
 let dots=false,last=0,acc=0,frames=0,fps=60,fpsStart=0;
 const scale=3,fw=Math.ceil(W/scale),fh=Math.ceil(H/scale);
 const field=new Float32Array(fw*fh),surface=document.createElement('canvas');
 surface.width=fw;surface.height=fh;
 const sctx=surface.getContext('2d'),img=sctx.createImageData(fw,fh);
 const cv=document.getElementById('visc'),ce=document.getElementById('elastic');
 const status=document.getElementById('status');
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 const smooth=(a,b,x)=>{let t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};
 const radial=17/scale,radiusSq=radial*radial;
 document.getElementById('reset').onclick=()=>sim.reset();
 document.getElementById('dots').onclick=()=>dots=!dots;
 cv.oninput=()=>{sim.viscosity=Number(cv.value)/100;document.getElementById('viscVal').textContent=cv.value+'%'};
 ce.oninput=()=>{sim.elasticity=Number(ce.value)/100;document.getElementById('elasticVal').textContent=ce.value+'%'};
 function pointer(e){const b=canvas.getBoundingClientRect();return [(e.clientX-b.left)*W/b.width,(e.clientY-b.top)*H/b.height]}
 canvas.addEventListener('pointerdown',e=>{
   const [x,y]=pointer(e);if(sim.beginGrab(e.pointerId,x,y)){
     e.preventDefault();canvas.setPointerCapture(e.pointerId);
   }
 },{passive:false});
 canvas.addEventListener('pointermove',e=>{const [x,y]=pointer(e);sim.moveGrab(e.pointerId,x,y)});
 for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>sim.endGrab(e.pointerId));
 function paintField(){
   field.fill(0);
   for(const p of sim.particles){
     const cx=p.x/scale,cy=p.y/scale;
     const x0=Math.max(0,Math.floor(cx-radial)),x1=Math.min(fw-1,Math.ceil(cx+radial));
     const y0=Math.max(0,Math.floor(cy-radial)),y1=Math.min(fh-1,Math.ceil(cy+radial));
     for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
       const dx=x+0.5-cx,dy=y+0.5-cy,r2=dx*dx+dy*dy;
       if(r2>=radiusSq)continue;
       field[y*fw+x]+=Math.exp(-r2/(radiusSq*.24));
     }
   }
   const out=img.data;
   for(let y=1;y<fh-1;y++)for(let x=1;x<fw-1;x++){
     const k=y*fw+x,o=k*4,d=field[k];
     const alpha=smooth(0.75,1.65,d),edge=1-smooth(1.1,2.35,d);
     const grad=(field[k+1]-field[k-1])*.25-(field[k+fw]-field[k-fw])*.18;
     const tint=Math.min(1,d/5.5);
     out[o]=Math.round(108+51*edge+22*tint+14*grad);
     out[o+1]=Math.round(215+27*edge+8*tint+4*grad);
     out[o+2]=Math.round(206+35*edge+17*tint);
     out[o+3]=Math.round(245*alpha);
   }
   sctx.putImageData(img,0,0);
 }
 function background(){
   const g=ctx.createLinearGradient(0,0,0,H);
   g.addColorStop(0,'#f9fbfc');g.addColorStop(0.65,'#f2f9f9');g.addColorStop(1,'#e7f1f1');
   ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
   ctx.strokeStyle='#dce8e9';ctx.lineWidth=1;
   for(let i=0;i<10;i++){
     const x=60+i*62;ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x-25,H);ctx.stroke();
   }
   // Side section glass tray is visual only; collision floor is in the solver.
   ctx.fillStyle='rgba(121,197,194,0.10)';
   ctx.strokeStyle='rgba(160,203,203,0.48)';ctx.lineWidth=7;
   ctx.beginPath();ctx.roundRect(63,345,514,121,41);ctx.fill();ctx.stroke();
   ctx.fillStyle='rgba(255,255,255,0.32)';ctx.fillRect(74,372,492,76);
   ctx.strokeStyle='rgba(255,255,255,0.76)';ctx.lineWidth=4;
   ctx.beginPath();ctx.moveTo(78,392);ctx.lineTo(78,433);ctx.stroke();
   ctx.fillStyle='rgba(59,146,142,.06)';ctx.beginPath();ctx.ellipse(319,457,245,23,0,0,2*Math.PI);ctx.fill();
 }
 function draw(){
   background();paintField();
   ctx.save();ctx.shadowColor='rgba(26,141,151,0.20)';ctx.shadowBlur=13;ctx.shadowOffsetY=7;
   ctx.imageSmoothingEnabled=true;ctx.drawImage(surface,0,0,W,H);ctx.restore();
   // Fine highlights are located on moving *material points*, not a fake strand.
   for(let i=7;i<sim.particles.length;i+=21){
     const p=sim.particles[i];
     ctx.fillStyle='rgba(255,255,255,0.62)';
     ctx.beginPath();ctx.arc(p.x-1,p.y-2,1.4,0,7);ctx.fill();
   }
   for(const grab of sim.grabs.values()){
     ctx.strokeStyle='rgba(255,255,255,.90)';ctx.lineWidth=2.5;
     ctx.beginPath();ctx.arc(grab.x,grab.y,15,0,7);ctx.stroke();
     ctx.strokeStyle='rgba(29,139,145,.27)';ctx.lineWidth=1;
     ctx.beginPath();ctx.arc(grab.x,grab.y,23,0,7);ctx.stroke();
   }
   if(dots)for(const p of sim.particles){
     ctx.fillStyle='#237e80';ctx.fillRect(p.x-1,p.y-1,2,2);
   }
   ctx.font='12px ui-rounded,system-ui,sans-serif';ctx.fillStyle='#78aaac';
   ctx.fillText('可拖动的同一批物质粒子 · 非独立拉丝',18,25);
 }
 function frame(now){
   requestAnimationFrame(frame);
   if(!last)last=now;if(!fpsStart)fpsStart=now;
   let dt=Math.min(.052,(now-last)/1000);last=now;acc+=dt;
   let count=0;while(acc>=1/60&&count<3){sim.step(1/60);acc-=1/60;count++;}
   if(count>=3)acc=0;
   draw();frames++;
   if(now-fpsStart>850){
     fps=Math.round(frames*1000/(now-fpsStart));frames=0;fpsStart=now;
     const m=sim.metrics();
     status.textContent='材料 '+m.particles+' 粒 · 弹性连接 '+m.bonds+' · '+fps+' FPS';
   }
 }
 requestAnimationFrame(frame);
})();
