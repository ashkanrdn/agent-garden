const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context=vm.createContext({});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../../web/garden-session-labels.js'),'utf8').replace(/export /g,''),context);
const {largestSessionIds,projectLabelCandidates}=context;
test('top ten use current work scores and deterministic ties without mutating input',()=>{
 const sessions=Array.from({length:12},(_,i)=>({id:String(i).padStart(2,'0'),work:i}));
 const ids=largestSessionIds(sessions,s=>s.work);
 assert.equal(ids.size,10);assert.equal(ids.has('00'),false);assert.equal(ids.has('11'),true);
 assert.equal(sessions[0].id,'00');
 assert.deepEqual([...largestSessionIds([{id:'b'},{id:'a'}],()=>0,1)],['a']);
 sessions[0].work=100;assert.equal(largestSessionIds(sessions,s=>s.work).has('00'),true);
 assert.equal(largestSessionIds([],()=>0).size,0);
});
test('overview groups top sessions into one label per lot; zoom reveals other lots',()=>{
 const plots=[{id:'small'},{id:'large'}];
 const sessions=[{id:'a',projectId:'large'},{id:'b',projectId:'large'}],largest=new Set(['a','b']);
 assert.deepEqual(Array.from(projectLabelCandidates(plots,sessions,largest,.199,.1),p=>p.id),['large']);
 assert.deepEqual(Array.from(projectLabelCandidates(plots,sessions,largest,.2,.1),p=>p.id),['large','small']);
 assert.equal(projectLabelCandidates([],sessions,largest,1,.1).length,0);
});
