const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
function harness(){
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync('web/garden-island-contours.js','utf8').replace(/export /g,''),context);
  let checks=0;const inside=context.inside;context.inside=(...args)=>{checks++;return inside(...args);};
  const outline=[{x:-400,y:-300},{x:400,y:-300},{x:400,y:300},{x:-400,y:300}];
  const geometry=context.buildIslandContours(outline);
  const art={save(){},restore(){},setLineDash(){},fillRect(){},fillText(){},translate(){},rotate(){},measureText:()=>({width:36})};
  const project=(x,y,z)=>({x:640+(x-y)*.2,y:300+((x+y)*.43-z)*.2});
  return{checks:()=>checks,draw:exclusions=>context.drawIslandSurvey(art,geometry,outline,project,{width:1280,height:800,exclusions})};
}
test('covered contour labels skip terrain visibility scans',()=>{
  const h=harness(),result=h.draw([{x:0,y:0,w:1280,h:800}]);
  assert.equal(result.labels,0);
  assert.equal(h.checks(),0,'hidden labels must not scan every vertex of every higher terrace');
});
test('visible survey labels retain their terrain visibility checks',()=>{
  const h=harness(),result=h.draw([]);
  assert.ok(result.labels>0);assert.ok(h.checks()>0);
});
