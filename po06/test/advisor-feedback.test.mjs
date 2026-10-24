import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createAdvisorCoverage} from '../lib/advisor-coverage.js'
import {reviewOutcome, renderReviewFeedback} from '../lib/advisor-outcome.js'
import {withAdvisorWorkflow} from '../lib/advisor-workflow.js'
import {createAdvisor} from '../lib/advisor.js'

const hash=x=>createHash('sha256').update(x).digest('hex')
const report=(status='unverified')=>({verdict:status==='satisfied'?'pass':'gaps',summary:'bounded',findings:[],checks:[{criterion:'runtime behavior',status,evidenceRefs:['F0']}],nextStep:'capture runtime',stopCondition:'ask user if unavailable'})
test('invocation success with gaps remains pending, and material problems are named',()=>{
 const out=reviewOutcome({ok:true,report:report(),materials:[{id:'F0',path:'app.js',status:'truncated'},{id:'F1',path:'missing.log',status:'unavailable',reason:'file-not-found'}]})
 assert.equal(out.invocationSucceeded,true); assert.equal(out.reviewPassed,false)
 assert.equal(out.openIssues.length,1);assert.deepEqual(out.evidenceGaps.map(m=>m.path),['app.js','missing.log'])
 assert.equal(out.disposition,'pending-verification')
 assert.equal(reviewOutcome({ok:true,partial:true,report:report('satisfied')}).reviewPassed,false)
})
test('unresolved checks survive restart and another round, omissions and unrelated reviews cannot erase them',()=>{
 const root=mkdtempSync(join(tmpdir(),'advisor-feedback-'));try {
  writeFileSync(join(root,'app.js'),'a')
  const base={sessionId:'s',requestId:'q1',scope:'code',focus:'behavior',materials:[{path:'app.js',sha256:hash('a'),status:'ready'}],revisionMarker:'v1',ok:true}
  let store=createAdvisorCoverage({home:root});store.record({...base,runId:'r1',report:report()})
  const opts={sessionId:'s',root,readEnabled:true,revisionMarker:'v1'}
  const before=store.feedback(opts),issue=before.openIssues.find(x=>x.criterion==='runtime behavior')
  store=createAdvisorCoverage({home:root});assert.equal(store.feedback(opts).openIssues.find(x=>x.criterion==='runtime behavior').id,issue.id)
  store.record({...base,runId:'r2',requestId:'q2',report:{...report('satisfied'),checks:[{criterion:'syntax',status:'satisfied',evidenceRefs:['F0']}]}})
  assert.ok(store.feedback(opts).openIssues.some(x=>x.id===issue.id))
  store.record({...base,runId:'r3',focus:'other',report:report('satisfied')})
  assert.ok(store.feedback(opts).openIssues.some(x=>x.id===issue.id))
  store.record({...base,runId:'r4',requestId:'q2',report:report('satisfied')})
  assert.equal(store.feedback(opts).openIssues.length,0)
  assert.equal(store.feedback({...opts,sessionId:'other'}).openIssues.length,0)
  writeFileSync(join(root,'app.js'),'b')
  assert.ok(store.feedback(opts).openIssues.some(x=>x.action==='review-current-version'))
  assert.ok(store.feedback({...opts,readEnabled:false}).openIssues.length)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('context carries pending state without pretending to establish full-task coverage; off gate stays off',()=>{
 const state={openIssues:[{id:'R1',criterion:'actual execution',action:'provide-evidence'}],limitations:[]}
 const text=renderReviewFeedback(state)
 assert.ok(text.includes('R1'));assert.ok(text.includes('待验收版本'));assert.ok(text.includes('不是用户新增要求'))
 assert.ok(withAdvisorWorkflow('packet',{injectPacket:true},text).includes('actual execution'))
 assert.equal(withAdvisorWorkflow('packet',{injectPacket:false},text),'packet')
})
test('actual advisor result exposes acceptance separately and persists gaps',async()=>{
 const root=mkdtempSync(join(tmpdir(),'advisor-call-'));try {
  writeFileSync(join(root,'app.js'),'a')
  const coverage=createAdvisorCoverage({home:root})
  const invoke=createAdvisor({coverage,resolveRuntime:async()=>({ok:true,cwd:root,readTools:true,cfg:{provider:'p',model:'m'},llm:{}}),runLoop:async()=>({text:JSON.stringify(report()),trace:[]})})
  const session={id:'s',snapshotEvents:()=>[{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'verify behavior'}]}}]}
  const out=await invoke({mode:'review_result',scope:'code',focus:'behavior',question:'check runtime',files:[{path:'app.js',purpose:'source'}]},{agent:{session}})
  assert.equal(out.ok,true);assert.equal(out.invocationSucceeded,true);assert.equal(out.reviewPassed,false)
  assert.ok(out.reviewState.openIssues.length);assert.equal(out.completionClaimAllowed,false)
  assert.ok(out.openIssues.every(i=>/^R/.test(i.id)))
  assert.ok(out.nextActions.some(i=>i.id===out.openIssues[0].id))
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('focused line range may pass only its focus; general cannot claim whole-artifact acceptance',async()=>{
 const root=mkdtempSync(join(tmpdir(),'advisor-range-'));try{
  writeFileSync(join(root,'app.js'),'first\nsecond\nthird\n')
  const invoke=createAdvisor({resolveRuntime:async()=>({ok:true,cwd:root,readTools:true,cfg:{provider:'p',model:'m'},llm:{}}),runLoop:async()=>({text:JSON.stringify(report('satisfied')),trace:[]})})
  const session={id:'s',snapshotEvents:()=>[{seq:1,type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'verify behavior'}]}}]}
  const args={mode:'review_result',scope:'code',focus:'behavior',question:'check range',files:[{path:'app.js',purpose:'function',startLine:2,endLine:2}]}
  const out=await invoke(args,{agent:{session}})
  assert.equal(out.reviewPassed,true);assert.equal(out.materials[0].wholeFileComplete,false)
  assert.equal(out.completionClaimAllowed,false)
  const broad=await invoke({...args,scope:'general'},{agent:{session}})
  assert.equal(broad.reviewPassed,false)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('failed calls never imply acceptance',async()=>{
 const invoke=createAdvisor({resolveRuntime:async()=>({ok:false,reason:'unavailable'})})
 const out=await invoke({mode:'review_result',question:'check'},{})
 assert.equal(out.invocationSucceeded,false);assert.equal(out.reviewPassed,false)
})
test('host context callback includes persisted gap state, honors off gate and session isolation',async()=>{
 const {adapter}=await import('../lib/index.js')
 const old={gate:adapter.enableGate,policy:adapter.policyNow,feedback:adapter.reviewFeedback}
 let provider
 try{
  adapter.enableGate={ensure:()=>({enabled:true})};adapter.policyNow=()=>({injectPacket:true})
  adapter.reviewFeedback=agent=>agent.id==='s'?renderReviewFeedback({openIssues:[{id:'R1',criterion:'runtime',action:'provide-evidence'}],limitations:[]}):''
  adapter.registerContext({inject:(_services,cb)=>cb({systemPrompt:{context:p=>{provider=p;return ()=>{}}}})})
  assert.ok(provider.text({agent:{id:'s'}}).includes('R1'))
  assert.ok(!provider.text({agent:{id:'other'}}).includes('R1'))
  adapter.policyNow=()=>({injectPacket:false})
  assert.equal(provider.text({agent:{id:'s'}}),'')
 }finally{adapter.enableGate=old.gate;adapter.policyNow=old.policy;adapter.reviewFeedback=old.feedback}
})

test('issue #38：动态上下文保留 cwd 等模板样字面量，不让宿主解析',async()=>{
 const {adapter}=await import('../lib/index.js')
 let provider
 adapter.registerContext({inject:(_services,cb)=>cb({systemPrompt:{context:p=>{provider=p;return ()=>{}}}})})
 assert.equal(provider.interpolate,false,'动态意图文本不是宿主变量模板，必须逐字保留')
})

test('empty material pass cannot close; material addition can close in same request',()=>{
 const root=mkdtempSync(join(tmpdir(),'advisor-empty-'));try{
  writeFileSync(join(root,'a.js'),'a'); const store=createAdvisorCoverage({home:root})
  const base={sessionId:'s',requestId:'q',scope:'code',focus:'behavior',ok:true,revisionMarker:'v1',materials:[]}
  store.record({...base,runId:'r1',report:report()});store.record({...base,runId:'r2',report:report('satisfied')})
  const opts={sessionId:'s',root,readEnabled:true,revisionMarker:'v1'}
  assert.ok(store.feedback(opts).openIssues.length);assert.ok(store.feedback(opts).limitations.includes('material-evidence-unavailable'))
  store.record({...base,runId:'r3',materials:[{path:'a.js',status:'ready',sha256:hash('a')}],report:report('satisfied')})
  assert.equal(store.feedback(opts).openIssues.length,0);assert.equal(store.feedback(opts).limitations.length,0)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('context uses session.id even when agent.id differs; missing session is visible',async()=>{
 const {reviewFeedbackForAgent}=await import('../lib/advisor-outcome.js')
 const calls=[]; const store={feedback:o=>{calls.push(o);return {openIssues:[{id:'R1',criterion:'pending'}],limitations:[]}}}
 const agent={id:'agent-id',session:{id:'session-id',header:{cwd:tmpdir()},snapshotEvents:()=>[]}}
 assert.ok(reviewFeedbackForAgent(store,agent,{readTools:false}).includes('R1'))
 assert.equal(calls[0].sessionId,'session-id');assert.equal(calls[0].readEnabled,false)
 assert.ok(reviewFeedbackForAgent(store,{id:'agent-id'},{}).includes('session-identity-unavailable'))
})

test('same focus with disjoint artifacts cannot hide or close older failures',()=>{
 const root=mkdtempSync(join(tmpdir(),'advisor-target-'));try{
  for(const p of ['a.js','b.js'])writeFileSync(join(root,p),'x')
  const store=createAdvisorCoverage({home:root});const base={sessionId:'s',scope:'code',focus:'behavior',revisionMarker:'v1',ok:true}
  for(const [n,path] of ['a.js','b.js'].entries())store.record({...base,runId:'r'+n,requestId:'q'+n,materials:[{path,status:'ready',sha256:hash('x')}],report:report('failed')})
  const opts={sessionId:'s',root,readEnabled:true,revisionMarker:'v1'}
  assert.equal(store.feedback(opts).openIssues.filter(x=>x.criterion==='runtime behavior').length,2)
  store.record({...base,runId:'r3',requestId:'q1',materials:[{path:'b.js',status:'ready',sha256:hash('x')}],report:report('satisfied')})
  const remain=store.feedback(opts).openIssues.filter(x=>x.criterion==='runtime behavior')
  assert.equal(remain.length,1);assert.deepEqual(remain[0].paths,['a.js'])
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('invalid identities and persistence failures are visible limitations',()=>{
 const root=mkdtempSync(join(tmpdir(),'advisor-store-fail-'));try{
  writeFileSync(join(root,'blocked'),'file')
  const store=createAdvisorCoverage({home:join(root,'blocked')})
  const row={sessionId:'s',requestId:'q',runId:'r',scope:'code',focus:'behavior',ok:true,report:report(),revisionMarker:'v1',materials:[]}
  assert.equal(store.record(row).ok,false)
  assert.ok(store.feedback({sessionId:'s',revisionMarker:'v1'}).limitations.includes('coverage-store-write-failed'))
  const memory=createAdvisorCoverage()
  assert.equal(memory.record({...row,requestId:'bad / id'}).ok,false)
  assert.ok(memory.feedback({sessionId:'s'}).limitations.includes('invalid-coverage-identity'))
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('unknown versions stay explicitly unverified and can close after a current evidenced review',()=>{
 const root=mkdtempSync(join(tmpdir(),'advisor-version-'));try{
  writeFileSync(join(root,'app.js'),'a');const store=createAdvisorCoverage({home:root})
  const row={sessionId:'s',requestId:'q',runId:'r1',scope:'code',focus:'behavior',ok:true,report:report('satisfied'),revisionMarker:null,materials:[{path:'app.js',status:'ready',sha256:hash('a')}]}
  store.record(row)
  const opts={sessionId:'s',root,readEnabled:true}
  assert.ok(store.feedback({...opts,revisionMarker:'unavailable'}).limitations.includes('review-version-unavailable'))
  store.record({...row,runId:'r2',revisionMarker:'v1'})
  assert.equal(store.feedback({...opts,revisionMarker:'v1'}).openIssues.length,0)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('acceptance banner lands in the tool output for the real tank-case shape',async()=>{
 const {acceptanceBanner,registerAdvisorTool}=await import('../lib/advisor.js')
 const value={mode:'review_result',ok:true,invocationSucceeded:true,reviewPassed:false,disposition:'pending-verification',
  report:{verdict:'gaps',summary:'默认机位存在破面与漂浮几何',nextStep:'先修炮塔破面再同机位重渲',checks:[
   {criterion:'默认机位剪影是否为当代主战坦克',status:'failed'},{criterion:'比例与接地感',status:'failed'},
   {criterion:'涂装与旧化是否干净',status:'failed'},{criterion:'有无破面/穿模导致的“空洞感”',status:'failed'},
   {criterion:'履带与裙板之间是否存在穿模',status:'unverified'}]},
  openIssues:[{id:'R1',criterion:'有无破面/穿模导致的“空洞感”',status:'failed',action:'repair-and-review'}]}
 let registered=null
 registerAdvisorTool({tools:{register:def=>{registered=def;return()=>{}}}},async()=>value)
 const rendered=JSON.parse(registered.output.render({},value)[0].text)
 const text=rendered.acceptanceBanner
 assert.equal(rendered.ok,true)
 assert.ok(text.startsWith('【顾问验收未通过 · 不得宣称完成】'),'横幅以JSON字段与报告同一步抵达模型')
 assert.ok(text.includes('通过 0 项 · 未通过 4 项 · 未验证 1 项'),'计数要能直接读出未通过数量')
 assert.ok(text.includes('不得宣称完成'),'横幅要明说不得宣称完成')
 assert.ok(text.includes('不代表整体通过') && text.includes('定向复核'),'要写清局部通过边界与补救方式')
 assert.ok(text.includes('先修炮塔破面再同机位重渲'),'下一步动作要随横幅带出')
 assert.ok(acceptanceBanner({mode:'review_result',ok:true,invocationSucceeded:true,reviewPassed:true,report:{verdict:'pass',checks:[{criterion:'x',status:'satisfied'}]}})==='','通过时不加横幅')
 assert.ok(acceptanceBanner({mode:'review_result',ok:false,reason:'advisor-invalid-citation'}).includes('顾问调用未成功'))
})
