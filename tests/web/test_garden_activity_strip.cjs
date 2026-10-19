const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../../web/garden-activity-strip.js'),'utf8').replace(/export /g,''),context);
const {buildDailyProjectActivity,layoutActivityCells}=context;
const DAY=86400000,START=Date.parse('2026-07-01T00:00:00Z');

test('counts distinct projects and sessions while mapping subagents to their primary project',()=>{
 const sessions=[
  {id:'root-a',projectId:'project-a',activity:[{at:'2026-07-01T01:00:00Z'},{at:'2026-07-01T01:00:00Z'}]},
  {id:'agent-a',isSubagent:true,rootSessionId:'root-a',projectId:'agent-worktree',activity:[{at:'2026-07-01T03:00:00Z'},{at:'2026-07-01T04:00:00Z'}]},
  {id:'root-b',projectId:'project-b',activity:[{at:'2026-07-01T05:00:00Z'}]},
 ];
 const result=buildDailyProjectActivity(sessions,{startTime:START,dayMs:DAY,maxDay:1});
 assert.deepEqual({...result[0]},{projectCount:2,sessionCount:3});
 assert.deepEqual({...result[1]},{projectCount:0,sessionCount:0});
});

test('uses UTC day boundaries from the supplied start time',()=>{
 const sessions=[{id:'root',projectId:'project',activity:[
  {at:'2026-07-01T23:59:59.999Z'},
  {at:'2026-07-02T00:00:00.000Z'},
  {at:'2026-07-01T20:00:00-04:00'},
 ]}];
 const result=buildDailyProjectActivity(sessions,{startTime:START,dayMs:DAY,maxDay:1});
 assert.deepEqual(Array.from(result,item=>({...item})),[
  {projectCount:1,sessionCount:1},
  {projectCount:1,sessionCount:1},
 ]);
});

test('ignores invalid activity and events outside the timeline range',()=>{
 const sessions=[
  {id:'root',projectId:'project',activity:[{at:'2026-06-30T23:59:59Z'},{at:'2026-07-03T00:00:00Z'},{at:'not-a-date'}]},
  {id:'orphan',isSubagent:true,rootSessionId:'missing',projectId:'wrong-project',activity:[{at:'2026-07-01T12:00:00Z'}]},
 ];
 const result=buildDailyProjectActivity(sessions,{startTime:START,dayMs:DAY,maxDay:1});
 assert.deepEqual(Array.from(result,item=>({...item})),[
  {projectCount:0,sessionCount:0},
  {projectCount:0,sessionCount:0},
 ]);
});

test('stacks fixed cells upward and adds a cap only when the stack overflows',()=>{
 const normal=layoutActivityCells(3,20);
 assert.equal(normal.capacity,4);assert.equal(normal.overflow,false);assert.equal(normal.cap,null);
 assert.deepEqual(Array.from(normal.rects,rect=>({...rect})),[{y:16,height:3},{y:12,height:3},{y:8,height:3}]);
 const overflow=layoutActivityCells(10,10);
 assert.equal(overflow.capacity,2);assert.equal(overflow.overflow,true);
 assert.deepEqual(Array.from(overflow.rects,rect=>({...rect})),[{y:6,height:3},{y:2,height:3}]);
 assert.deepEqual({...overflow.cap},{y:0,height:1});
});
