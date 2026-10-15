/* 小海 · 独立二维黏弹性材料实验内核
 * Inspired by Clavet/Beaudoin/Poulin 2005 (algorithmic approach, original implementation).
 * Persistent equal-mass material particles are the ONLY source of gel geometry.
 * Spatial hash + density relaxation + viscosity + plastic, breakable cohesive bonds.
 */
(function(root,factory){
  const value=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=value;
  else root.GelPhysics=value;
})(typeof window!=='undefined'?window:globalThis,function(){
  'use strict';
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const hypot=Math.hypot;
  class Gel {
    constructor(options={}){
      this.width=640;this.height=520;
      this.left=69;this.right=571;this.floor=448;
      this.radius=23;this.particles=[];this.bonds=new Map();
      this.grabs=new Map();this.stepCount=0;
      this.gravity=0.18;this.viscosity=0.18;this.elasticity=0.28;
      this.plasticity=0.006;this.restDensity=5.0;
      this.reset();
    }
    reset(){
      this.particles=[];this.bonds.clear();this.grabs.clear();this.stepCount=0;
      // Slightly irregular dense arrangement, independent of display resolution.
      const rows=11.4,columns=11.4;
      let i=0;
      for(let y=0;y<13;y++)for(let x=0;x<31;x++){
        const px=320+(x-15)*columns+(y%2)*columns*0.5;
        const py=350+(y-6)*rows;
        const nx=(px-320)/179,ny=(py-350)/78;
        if(nx*nx+ny*ny>1)continue;
        const wobble=Math.sin(i*12.9898)*0.35;
        this.particles.push({x:px+wobble,y:py-wobble,px:px+wobble,py:py-wobble,
          vx:0,vy:0,id:i++});
      }
      this.originalCount=this.particles.length;
    }
    _cell(x,y){
      const h=this.radius;return Math.floor(x/h)+':'+Math.floor(y/h);
    }
    _neighbors(){
      const buckets=new Map(),list=[];
      const p=this.particles,h=this.radius;
      for(let i=0;i<p.length;i++){
        const key=this._cell(p[i].x,p[i].y);
        let arr=buckets.get(key);if(!arr)buckets.set(key,arr=[]);arr.push(i);
      }
      for(let i=0;i<p.length;i++){
        const a=p[i],gx=Math.floor(a.x/h),gy=Math.floor(a.y/h);
        for(let yy=-1;yy<=1;yy++)for(let xx=-1;xx<=1;xx++){
          const arr=buckets.get((gx+xx)+':'+(gy+yy));if(!arr)continue;
          for(let n=0;n<arr.length;n++){
            const j=arr[n];if(j<=i)continue;
            const b=p[j],dx=b.x-a.x,dy=b.y-a.y,r=Math.hypot(dx,dy);
            if(r>0.0001&&r<h)list.push({i,j,r,q:r/h});
          }
        }
      }
      return list;
    }
    _bondKey(i,j){return i+':'+j;}
    _viscosity(pairs,dt){
      for(const e of pairs){
        const a=this.particles[e.i],b=this.particles[e.j];
        const nx=(b.x-a.x)/e.r,ny=(b.y-a.y)/e.r;
        const radial=(a.vx-b.vx)*nx+(a.vy-b.vy)*ny;
        if(radial<=0)continue;
        const impulse=(1-e.q)*(this.viscosity*radial+0.012*radial*radial)*0.5*dt;
        a.vx-=impulse*nx;a.vy-=impulse*ny;
        b.vx+=impulse*nx;b.vy+=impulse*ny;
      }
    }
    _springs(pairs,dt){
      const added=new Set();
      // Springs form when neighbors touch; stretching changes rest length (plastic flow).
      // They can rupture and later reform; not a permanent rubber mesh.
      const maxSprings=this.particles.length*12;
      for(const e of pairs){
        const key=this._bondKey(e.i,e.j);
        if(!this.bonds.has(key)&&e.q<0.79&&this.bonds.size<maxSprings){
          this.bonds.set(key,{i:e.i,j:e.j,rest:e.r});
        }
        added.add(key);
      }
      for(const [key,bond] of this.bonds){
        const a=this.particles[bond.i],b=this.particles[bond.j];
        const dx=b.x-a.x,dy=b.y-a.y,len=hypot(dx,dy)||0.0001;
        if(len>this.radius*2.75){this.bonds.delete(key);continue;}
        const yieldPoint=0.2*bond.rest,stretch=len-bond.rest;
        if(Math.abs(stretch)>yieldPoint){
          bond.rest+=clamp(stretch-Math.sign(stretch)*yieldPoint,-0.8,0.8)*this.plasticity*dt;
        }
        const correction=clamp(stretch*this.elasticity*0.5*dt,-1.6,1.6)/len;
        a.x+=dx*correction;a.y+=dy*correction;
        b.x-=dx*correction;b.y-=dy*correction;
      }
    }
    _density(pairs,dt){
      const p=this.particles,n=p.length;
      const rho=new Float32Array(n),near=new Float32Array(n);
      for(const e of pairs){
        const w=1-e.q, a=w*w,b=w*w*w;
        rho[e.i]+=a;rho[e.j]+=a;
        near[e.i]+=b;near[e.j]+=b;
      }
      // Each push applies equal and opposite displacement; gel remains material.
      for(const e of pairs){
        const a=p[e.i],b=p[e.j],w=1-e.q;
        const pi=clamp(0.12*(rho[e.i]-this.restDensity),-0.28,1.0);
        const pj=clamp(0.12*(rho[e.j]-this.restDensity),-0.28,1.0);
        const pressure=(pi+pj)*0.5*w+(near[e.i]+near[e.j])*0.5*0.14*w*w;
        const amount=clamp(pressure*0.5*dt*dt,-0.42,0.72)/e.r;
        const dx=(b.x-a.x)*amount,dy=(b.y-a.y)*amount;
        a.x-=dx;a.y-=dy;b.x+=dx;b.y+=dy;
      }
    }
    beginGrab(id,x,y){
      const nearest=this.particles.map((p,i)=>({i,r:hypot(p.x-x,p.y-y)}))
        .filter(e=>e.r<32).sort((a,b)=>a.r-b.r).slice(0,9);
      if(nearest.length===0)return false;
      this.grabs.set(id,{x,y,indices:nearest.map(e=>({i:e.i,w:clamp(1-e.r/42,0.24,1)}))});
      return true;
    }
    moveGrab(id,x,y){
      const p=this.grabs.get(id);
      if(p){p.x=clamp(x,30,610);p.y=clamp(y,25,460);}
    }
    endGrab(id){this.grabs.delete(id);}
    _grabConstraints(dt){
      for(const g of this.grabs.values()){
        for(const e of g.indices){
          const p=this.particles[e.i];
          let dx=g.x-p.x,dy=g.y-p.y,dist=hypot(dx,dy);
          if(dist<1e-4)continue;
          const travel=Math.min(7.5*dt,dist*0.4*e.w*dt);
          p.x+=dx/dist*travel;p.y+=dy/dist*travel;
        }
      }
    }
    _walls(){
      for(const p of this.particles){
        p.x=clamp(p.x,this.left+5,this.right-5);
        p.y=clamp(p.y,20,this.floor-4);
      }
    }
    _step(dt){
      const pts=this.particles;
      this._viscosity(this._neighbors(),dt);
      for(const p of pts){
        p.px=p.x;p.py=p.y;
        p.vx*=0.995;p.vy=(p.vy+this.gravity*dt)*0.995;
        p.x+=p.vx*dt;p.y+=p.vy*dt;
      }
      // Pairs rebuilt after prediction; density and bonds share material particles.
      const pairs=this._neighbors();
      this._springs(pairs,dt);
      this._density(pairs,dt);
      this._grabConstraints(dt);
      this._walls();
      for(const p of pts){
        p.vx=clamp((p.x-p.px)/dt,-24,24);
        p.vy=clamp((p.y-p.py)/dt,-24,24);
        if(p.y>=this.floor-4&&p.vy>0)p.vy*=0.08;
      }
      this.stepCount++;
    }
    step(dt=1/60){
      const fixed=Math.min(1/30,Math.max(0,dt))*60;
      const sub=3,frame=fixed/sub;
      for(let k=0;k<sub;k++)this._step(frame);
    }
    metrics(){
      let minY=Infinity,maxY=-Infinity;
      for(const p of this.particles){minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
      return {particles:this.particles.length,bonds:this.bonds.size,grabs:this.grabs.size,
        minY,maxY,steps:this.stepCount};
    }
  }
  return {Gel};
});
