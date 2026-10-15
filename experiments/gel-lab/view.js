/* 小海 gel-lab: all visible gel geometry is reconstructed from material particles. */
(function(){
 'use strict';
 const canvas=document.getElementById('gel'),ctx=canvas.getContext('2d',{alpha:false});
 const W=640,H=430,sim=new GelPhysics.Gel();
 let showParticles=false,last=0,acc=0,frames=0,fpsStart=0;
 const scale=3,fw=Math.ceil(W/scale),fh=Math.ceil(H/scale);
 const field=new Float32Array(fw*fh);
 const surface=document.createElement('canvas');
 surface.width=fw;surface.height=fh;
 const sctx=surface.getContext('2d'),img=sctx.createImageData(fw,fh);
 const visc=document.getElementById('visc'),elastic=document.getElementById('elastic'),status=document.getElementById('status');
 const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
 function smooth(a,b,x){
   const t=clamp((x-a)/(b-a),0,1);
   return t*t*(3-2*t);
 }
 const radial=25/scale,radSq=radial*radial;
 const foamIds=[17,48,73,111,168,204,241,278,319,347,386];
 document.getElementById('reset').onclick=()=>sim.reset();
 document.getElementById('dots').onclick=()=>showParticles=!showParticles;
 visc.oninput=()=>{sim.viscosity=Number(visc.value)/100;document.getElementById('viscVal').textContent=visc.value+'%';};
 elastic.oninput=()=>{sim.elasticity=Number(elastic.value)/100;document.getElementById('elasticVal').textContent=elastic.value+'%';};
 function pointer(e){
   const rect=canvas.getBoundingClientRect();
   return [(e.clientX-rect.left)*W/rect.width,(e.clientY-rect.top)*H/rect.height];
 }
 canvas.addEventListener('pointerdown',e=>{
   const [x,y]=pointer(e);
   if(sim.beginGrab(e.pointerId,x,y)){
     e.preventDefault();
     canvas.setPointerCapture(e.pointerId);
   }
 },{passive:false});
 canvas.addEventListener('pointermove',e=>{
   const [x,y]=pointer(e);
   sim.moveGrab(e.pointerId,x,y);
 },{passive:false});
 for(const type of ['pointerup','pointercancel','lostpointercapture']){
   canvas.addEventListener(type,e=>sim.endGrab(e.pointerId));
 }
 // Each dye pixel is reconstructed from the *same persistent particles*.
 // No separately drawn strands, morph paths, or copied top layers.
 function paintField(){
   field.fill(0);
   for(const p of sim.particles){
     const cx=p.x/scale,cy=p.y/scale;
     const x0=Math.max(1,Math.floor(cx-radial)),x1=Math.min(fw-2,Math.ceil(cx+radial));
     const y0=Math.max(1,Math.floor(cy-radial)),y1=Math.min(fh-2,Math.ceil(cy+radial));
     for(let y=y0;y<=y1;y++){
       const dy=y+0.5-cy,dy2=dy*dy,offset=y*fw;
       for(let x=x0;x<=x1;x++){
         const dx=x+0.5-cx,r2=dx*dx+dy2;
         if(r2>=radSq)continue;
         const t=1-r2/radSq;
         field[offset+x]+=3.8*t*t*t;
       }
     }
   }
   const out=img.data;
   for(let y=0;y<fh;y++){
     for(let x=0;x<fw;x++){
       const k=y*fw+x,o=k*4;
       if(x===0||y===0||x===fw-1||y===fh-1){
         out[o]=out[o+1]=out[o+2]=out[o+3]=0;continue;
       }
       const density=field[k];
       const alpha=smooth(0.63,1.40,density), edge=1-smooth(1.0,3.3,density);
       const nx=field[k-1]-field[k+1],ny=field[k-fw]-field[k+fw];
       const light=clamp(0.58+nx*0.23+ny*0.22,0,1);
       const depth=clamp((density-1.2)/5,0,1);
       const frost=light*edge;
       out[o]=Math.round(clamp(72+53*frost+37*depth+12*ny,0,255));
       out[o+1]=Math.round(clamp(193+40*frost+16*depth+9*ny,0,255));
       out[o+2]=Math.round(clamp(185+49*frost+25*depth+8*ny,0,255));
       out[o+3]=Math.round((0.79+depth*0.16)*255*alpha);
     }
   }
   sctx.putImageData(img,0,0);
 }
 function paperAndTray(){
   const g=ctx.createLinearGradient(0,0,0,H);
   g.addColorStop(0,'#F9FCFB');g.addColorStop(0.62,'#F0F8F7');g.addColorStop(1,'#E5F1EF');
   ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
   const halo=ctx.createRadialGradient(322,245,10,322,245,330);
   halo.addColorStop(0,'rgba(219,252,247,0.60)');halo.addColorStop(1,'rgba(240,252,248,0)');
   ctx.fillStyle=halo;ctx.fillRect(0,0,W,H);
   ctx.fillStyle='rgba(55,147,148,0.13)';
   ctx.beginPath();ctx.ellipse(320,400,254,19,0,0,2*Math.PI);ctx.fill();
   const glass=ctx.createLinearGradient(0,178,0,410);
   glass.addColorStop(0,'rgba(255,255,255,.69)');
   glass.addColorStop(0.25,'rgba(191,230,230,.34)');
   glass.addColorStop(1,'rgba(138,215,208,.23)');
   ctx.fillStyle=glass;
   ctx.beginPath();ctx.roundRect(51,166,538,241,64);ctx.fill();
   ctx.strokeStyle='rgba(123,194,193,.52)';
   ctx.lineWidth=6;ctx.stroke();
   ctx.strokeStyle='rgba(255,255,255,.95)';
   ctx.lineWidth=2;
   ctx.beginPath();ctx.roundRect(58,173,524,227,60);ctx.stroke();
 }
 function glassFront(){
   // Front rim overlays the material like the glass wall of a physical tub.
   const f=ctx.createLinearGradient(0,325,0,410);
   f.addColorStop(0,'rgba(224,250,248,0)');
   f.addColorStop(0.68,'rgba(227,248,245,.16)');
   f.addColorStop(1,'rgba(223,244,241,.53)');
   ctx.fillStyle=f;
   ctx.beginPath();ctx.roundRect(56,170,528,232,59);ctx.fill();
   ctx.strokeStyle='rgba(255,255,255,.8)';
   ctx.lineWidth=5;
   ctx.beginPath();ctx.moveTo(69,226);ctx.lineTo(69,355);ctx.stroke();
   ctx.strokeStyle='rgba(255,255,255,.66)';
   ctx.lineWidth=3;
   ctx.beginPath();ctx.moveTo(567,232);ctx.lineTo(567,353);ctx.stroke();
 }
 function sparkle(x,y,r){
   ctx.save();ctx.translate(x,y);
   ctx.strokeStyle='rgba(255,255,255,.7)';
   ctx.lineWidth=1.4;ctx.beginPath();
   ctx.moveTo(-r,0);ctx.quadraticCurveTo(0,0,0,-r*1.6);
   ctx.quadraticCurveTo(0,0,r,0);
   ctx.quadraticCurveTo(0,0,0,r*1.6);
   ctx.quadraticCurveTo(0,0,-r,0);ctx.stroke();
   ctx.restore();
 }
 function materialDecorations(){
   // A few tiny inclusions follow particle IDs, not the bowl / mouse / overlay.
   for(let i=13;i<sim.particles.length;i+=17){
     const p=sim.particles[i];
     const r=(i%5===0?2.5:1.35);
     ctx.fillStyle='rgba(255,255,255,.55)';
     ctx.beginPath();ctx.ellipse(p.x-1,p.y-2,r*1.2,r*.7,-.4,0,2*Math.PI);ctx.fill();
   }
   for(const id of foamIds){
     const p=sim.particles[id];if(!p)continue;
     sparkle(p.x,p.y,2.6+(id%3)*.5);
   }
 }
 function draw(){
   paperAndTray();paintField();
   ctx.save();
   ctx.shadowColor='rgba(41,157,151,.19)';ctx.shadowBlur=9;ctx.shadowOffsetY=5;
   ctx.imageSmoothingEnabled=true;ctx.drawImage(surface,0,0,W,H);ctx.restore();
   materialDecorations();
   glassFront();
   for(const grab of sim.grabs.values()){
     const r=20;
     ctx.strokeStyle='rgba(255,255,255,.97)';ctx.lineWidth=2;
     ctx.beginPath();ctx.arc(grab.x,grab.y,r,0,2*Math.PI);ctx.stroke();
     ctx.strokeStyle='rgba(40,145,144,.40)';ctx.lineWidth=1;
     ctx.beginPath();ctx.arc(grab.x,grab.y,r+7,0,2*Math.PI);ctx.stroke();
   }
   if(showParticles){
     for(const p of sim.particles){
       ctx.fillStyle='#154e55';ctx.beginPath();ctx.arc(p.x,p.y,1.55,0,2*Math.PI);ctx.fill();
     }
   }
   ctx.fillStyle='#639999';ctx.font='12px ui-rounded,"PingFang SC",system-ui,sans-serif';
   ctx.fillText('抓住这团胶体，向上提拉 · 再松开',21,32);
 }
 function frame(t){
   requestAnimationFrame(frame);
   if(!last)last=t;if(!fpsStart)fpsStart=t;
   const dt=Math.min(.055,(t-last)/1000);last=t;acc+=dt;
   let steps=0;
   while(acc>=1/60&&steps<2){sim.step(1/60);acc-=1/60;steps++;}
   if(steps>=2)acc=0;
   draw();frames++;
   if(t-fpsStart>900){
     const fps=Math.round(frames*1000/(t-fpsStart));frames=0;fpsStart=t;
     const m=sim.metrics();
     status.textContent='胶体 '+m.particles+' 粒 · 连接 '+m.bonds+' · '+fps+' FPS';
   }
 }
 requestAnimationFrame(frame);
})();
