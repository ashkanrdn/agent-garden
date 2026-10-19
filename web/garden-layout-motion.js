/** Interruptible display geometry. Evidence geometry remains the exact power diagram. */
const mix = (a, b, t) => a + (b - a) * t;
const blend = (a, b, t) => ({x: mix(a.x,b.x,t), y: mix(a.y,b.y,t)});
const ease = t => 1 - (1-t)**3;
function perimeter(polygon) {
 const lengths=polygon.map((p,i)=>Math.hypot(p.x-polygon[(i+1)%polygon.length].x,p.y-polygon[(i+1)%polygon.length].y));
 const total=lengths.reduce((a,b)=>a+b,0)||1;let sum=0;
 return {polygon, stops:lengths.map(length=>{const stop=sum/total;sum+=length;return stop})};
}
function vertexAt(shape,t) {
 let i=shape.stops.length-1;while(i>0&&shape.stops[i]>t)i--;
 return blend(shape.polygon[i],shape.polygon[(i+1)%shape.polygon.length],(t-shape.stops[i])/((shape.stops[i+1]??1)-shape.stops[i]||1));
}
function polygonMorph(a,b) {
 if(!a?.length||!b?.length)return t=>b;
 const from=perimeter(a);
 // Polygon vertex zero is arbitrary after clipping. Match cyclic orientation
 // before interpolating; otherwise an unchanged square can collapse to its center.
 const normalize=polygon=>{const c=polygon.reduce((c,p)=>({x:c.x+p.x/polygon.length,y:c.y+p.y/polygon.length}),{x:0,y:0}),r=Math.max(...polygon.map(p=>Math.hypot(p.x-c.x,p.y-c.y)))||1;return polygon.map(p=>({x:(p.x-c.x)/r,y:(p.y-c.y)/r}))};
 const reference=perimeter(normalize(a));let aligned=b,best=Infinity;
 for(let shift=0;shift<b.length;shift++){
  const candidate=b.slice(shift).concat(b.slice(0,shift)),shape=perimeter(normalize(candidate));let cost=0;
  for(let i=0;i<24;i++){const p=vertexAt(reference,i/24),q=vertexAt(shape,i/24);cost+=(p.x-q.x)**2+(p.y-q.y)**2}
  if(cost<best){best=cost;aligned=candidate}
 }
 const to=perimeter(aligned);let stops=[...new Set([...from.stops,...to.stops])].sort((x,y)=>x-y);
 // Rapid replay retargets an already interpolated polygon. Bound its complexity.
 if(stops.length>96)stops=Array.from({length:96},(_,i)=>i/96);
 const pairs=stops.map(t=>[vertexAt(from,t),vertexAt(to,t)]);
 return t=>t===0?a:t===1?b:pairs.map(([p,q])=>blend(p,q,t));
}
// Even-odd test: planting polygons are concave where the jagged shore clips a lot.
function inside(point,polygon){let odd=false;for(let i=0;i<polygon.length;i++){const a=polygon[i],b=polygon[(i+1)%polygon.length];if((a.y>point.y)!==(b.y>point.y)&&point.x<(b.x-a.x)*(point.y-a.y)/(b.y-a.y)+a.x)odd=!odd}return odd}
function contain(point,polygon,center){if(inside(point,polygon))return point;let low=0,high=1;for(let i=0;i<24;i++){const t=(low+high)/2;if(inside(blend(center,point,t),polygon))low=t;else high=t}return blend(center,point,low*.98)}
export function createLayoutMotion({duration=620}={}) {
 let target=null,shown=null,transition=null;
 function sample(now) {
  if(!transition)return shown;
  const progress=Math.max(0,Math.min(1,(now-transition.start)/duration)),t=ease(progress);
  if(progress===1){shown=target;transition=null;return shown}
  const plots=target.layout.plots.map((plot,i)=>{
   const old=transition.plots.get(plot.id),enter=Math.max(0,Math.min(1,(progress-Math.min(i*0.045,.18))/(1-Math.min(i*0.045,.18))));
   const arrival=1-Math.exp(-7*enter)*Math.cos(9*enter),center=plot.centroid;
   const transform=p=>({x:center.x+(p.x-center.x)*(0.95+.05*arrival),y:center.y+(p.y-center.y)*(0.95+.05*arrival)});
   const polygon=old?transition.morphs.get(plot.id)(t):plot.polygon.map(transform);
   const xs=polygon.map(p=>p.x),ys=polygon.map(p=>p.y);
   return {...plot,polygon,x:Math.min(...xs),y:Math.min(...ys),w:Math.max(...xs)-Math.min(...xs),h:Math.max(...ys)-Math.min(...ys),
    centroid:old?blend(old.centroid,center,t):center,labelAnchor:old?blend(old.labelAnchor,plot.labelAnchor,t):transform(plot.labelAnchor),
    arrivalScale:old?1:0.95+.05*arrival,lift:old?mix(old.lift||0,0,t):-15*(1-arrival),opacity:old?mix(old.opacity??1,1,t):.15+.85*ease(enter),
    planting:{...plot.planting,polygon:old?transition.planting.get(plot.id)(t):plot.planting.polygon.map(transform)}};
  });
  const byPlot=new Map(plots.map(p=>[p.id,p]));
  const trees=target.trees.map(tree=>{
   const old=transition.trees.get(tree.s.id),plot=byPlot.get(tree.plotId);
   const position=old?blend(old,tree,t):plot?{x:plot.centroid.x+(tree.x-plot.centroid.x)*plot.arrivalScale,y:plot.centroid.y+(tree.y-plot.centroid.y)*plot.arrivalScale}:tree;
   return {...tree,...(plot?contain(position,plot.planting.polygon,plot.centroid):position),lift:plot?.lift||0,opacity:plot?.opacity??1};
  });
  shown={layout:{...target.layout,outline:transition.outline(t),plots},trees,active:true};return shown;
 }
 return {
  retarget(layout,trees,now,{animate=true,reset=false}={}) {
   const previous=sample(now);target={layout,trees,active:false};
   if(!previous||!animate||reset){shown=target;transition=null;return shown}
   const plots=new Map(previous.layout.plots.map(p=>[p.id,p]));
   const treeStarts=new Map(previous.trees.map(t=>[t.s.id,t]));
   for(const tree of trees){if(treeStarts.has(tree.s.id))continue;const old=plots.get(tree.plotId),plot=layout.plots.find(p=>p.id===tree.plotId);if(!old||!plot)continue;
    const candidate={x:old.centroid.x+(tree.x-plot.centroid.x)*old.w/plot.w,y:old.centroid.y+(tree.y-plot.centroid.y)*old.h/plot.h};
    treeStarts.set(tree.s.id,contain(candidate,old.planting.polygon,old.centroid));
   }
   transition={start:now,plots,trees:treeStarts,outline:polygonMorph(previous.layout.outline,layout.outline),
    morphs:new Map(layout.plots.filter(p=>plots.has(p.id)).map(p=>[p.id,polygonMorph(plots.get(p.id).polygon,p.polygon)])),
    planting:new Map(layout.plots.filter(p=>plots.has(p.id)).map(p=>[p.id,polygonMorph(plots.get(p.id).planting.polygon,p.planting.polygon)]))};
   return sample(now);
  },
  sample,
  settle(){transition=null;shown=target;return shown},
  get active(){return !!transition},
 };
}
