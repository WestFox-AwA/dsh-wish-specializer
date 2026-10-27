import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createAdvisor} from '../lib/advisor.js'
import {createAdvisorStages} from '../lib/advisor-stages.js'
import {runReadOnlyToolLoop} from '../lib/read-tools.js'
import {createControlHandler} from '../lib/control-api.js'
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=','base64')
const human={type:'user/message',seq:1,data:{source:{kind:'user'},content:[{type:'text',text:'Original required object and actual quality.'}]}}
const exec={agent:{session:{id:'loop-s',snapshotEvents:()=>[human]}}}
const report=(status='satisfied',refs=['I0'],extra={})=>({verdict:status==='satisfied'?'pass':status==='failed'?'gaps':'unverified',summary:'Actual scoped observation.',findings:[],checks:[{criterion:'Actual object relationship',status,evidenceRefs:refs,...extra}],nextStep:'Use only the verified scoped result.',stopCondition:'Recheck if object or evidence changes.'})
const loopShape={make:({callId,content,isError})=>({role:'tool',toolCallId:callId,content,isError,source:{kind:'tool',callId}})}
const stream=(value,usage={totalTokens:5})=>(async function*(){yield{type:'text-delta',text:JSON.stringify(value)};yield{type:'usage',usage};yield{type:'finish',reason:{kind:'stop'}}})()
function fixture(){const root=mkdtempSync(join(tmpdir(),'advisor-loop-'));writeFileSync(join(root,'source.txt'),'TOP SECRET IMPLEMENTATION FACT\n');writeFileSync(join(root,'view.png'),image);return root}
const args={mode:'review_result',scope:'geometry',focus:'Actual object relationship',question:'Observe image then independently resolve exact implementation fact.',files:[{path:'source.txt',purpose:'Exact implementation value'}],images:[{path:'view.png',purpose:'Actual object view',evidenceType:'runtime-capture'}]}
const runtime=(root,llm)=>({ok:true,cwd:root,readTools:true,imageSupport:true,cfg:{provider:'p',model:'m',reasoningEffort:'max'},attachments:{saveImage:async()=>({attachmentId:'local-actual-test',mediaType:'image/png',bytes:image.length,width:1,height:1})},llm})
test('first observer receives no source/self-evaluation; useful second phase sees support and both streams are counted',async()=>{
 const root=fixture();let first,second;try{
 const invoke=createAdvisor({resolveRuntime:async()=>runtime(root,{stream:o=>{first=o;return stream(report('unverified',['I0'],{gapKind:'source'}))}}),runLoop:async o=>{second=o;return{text:JSON.stringify(report('satisfied',['I0','F0'])),trace:[],usageSum:{totalTokens:7}}}})
 const out=await invoke({...args,question:args.question+' EXECUTOR_ALL_PASSED'},exec);assert.equal(out.ok,true);assert.equal(out.reviewPassed,true)
 assert.equal(first.messages[0].content[0].text.includes('EXECUTOR_ALL_PASSED'),false);assert.ok(second.messages[0].content[0].text.includes('EXECUTOR_ALL_PASSED'))
 assert.equal(first.messages[0].content[0].text.includes('TOP SECRET IMPLEMENTATION FACT'),false)
 assert.ok(second.messages[0].content[0].text.includes('TOP SECRET IMPLEMENTATION FACT'))
 assert.equal(first.messages[0].content.filter(x=>x.type==='image').length,1);assert.equal(out.usage.totalTokens,12);assert.equal(second.count,2)
 // 回归（2026-10-26）：顾问的工具循环必须带上会话标识，否则 opencode 系网关 400 MissingSessionID
 assert.equal(second.sessionId,'loop-s','工具循环必须收到本会话 id')
 assert.equal(first.sessionId,'loop-s','直连那一轮也必须带会话 id')
 assert.equal(out.completionClaimAllowed,false)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('source cannot erase a frozen visible failure or unknown/missing view',async()=>{
 const root=fixture();try{for(const [status,gap]of [['failed',undefined],['unverified','view'],['unverified','unknown']]){
 const first=report(status,['I0'],{gapKind:gap});first.findings=[{text:'Visible discrepancy or missing view',evidenceRefs:['I0'],needsSource:true}]
 const invoke=createAdvisor({resolveRuntime:async()=>runtime(root,{stream:()=>stream(first)}),runLoop:async()=>({text:JSON.stringify(report('satisfied',['I0','F0'])),trace:[]})})
 const out=await invoke(args,exec);assert.equal(out.reviewPassed,false);assert.equal(out.report.checks[0].status,status)
 }}finally{rmSync(root,{recursive:true,force:true})}
})
test('no useful support means one image call, absent actual image means zero model calls',async()=>{
 const root=fixture();let models=0,tools=0;try{const invoke=createAdvisor({resolveRuntime:async()=>runtime(root,{stream:()=>{models++;return stream({...report('satisfied',['I0']),findings:[{text:'Positive image observation.',evidenceRefs:['I0']}]})}}),runLoop:async()=>{tools++;throw Error('unused')}})
 assert.equal((await invoke(args,exec)).reviewPassed,true);assert.equal(models,1);assert.equal(tools,0)
 const missing=await invoke({...args,images:[]},exec);assert.equal(missing.reason,'visual-evidence-required');assert.equal(models,1);assert.equal(tools,0)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('explicit source target changing after an unchanged image observation cannot remain accepted',async()=>{
 const root=fixture();try{const invoke=createAdvisor({resolveRuntime:async()=>runtime(root,{stream:()=>{writeFileSync(join(root,'source.txt'),'changed target');return stream(report('satisfied',['I0']))}})})
 const out=await invoke({...args,subjectPaths:['source.txt']},exec);assert.equal(out.reviewPassed,false);assert.equal(out.report.verdict,'unverified');assert.equal(out.subjectProblem,'review-target-changed-or-unreadable')
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('real repeated improve invocation carries observed previous material, not just a reminder',async()=>{
 let seen,calls=0;const invoke=createAdvisor({resolveRuntime:async()=>({ok:true,readTools:false,cfg:{provider:'p',model:'m'},llm:{stream:o=>{calls++;seen=JSON.parse(o.messages[0].content[0].text);return stream({verdict:'suggestion',summary:'A specific optional gain.',contribution:'Use this concrete change and compare.',assumptions:[],findings:[{text:'The actual current material',evidenceRefs:seen.comparisonContext?['R0','P0']:['R0']}],checks:[],nextStep:'Compare actual results.',stopCondition:'Keep if no gain.'})}}})})
 const a=await invoke({mode:'improve_result',question:'Improve current',currentResult:'Actual original result.'},exec);assert.equal(a.contributionRecord.baselineSaved,true)
 const b=await invoke({mode:'improve_result',question:'Improve current',currentResult:'Actually changed result.'},exec)
 assert.equal(calls,2);assert.equal(seen.comparisonContext.before[0].text,'Actual original result.');assert.equal(b.comparison.benefitVerified,false);assert.equal(b.reviewPassed,false)
})
test('trusted actual control route validates exact turn identity and does not accept remote origins',async()=>{
 let seen;const handler=createControlHandler({advisorDelivery:async(sid,seq)=>{seen={sid,seq};return{ok:true,sessionId:sid,seq,status:'verification-pending',scopeOnly:true,completionClaimAllowed:false}}})
 const request=async(url,headers={host:'127.0.0.1:19387'})=>{let code,body;await handler({method:'GET',url,headers},{writeHead:c=>{code=c},end:s=>{body=JSON.parse(s)}});return{code,body}}
 const out=await request('/po06/api/advisor-delivery?session=s1&seq=9');assert.equal(out.code,200);assert.deepEqual(seen,{sid:'s1',seq:9});assert.equal(out.body.completionClaimAllowed,false)
 assert.equal((await request('/po06/api/advisor-delivery?session=s1&seq=NaN')).code,400)
 assert.notEqual((await request('/po06/api/advisor-delivery?session=s1&seq=9',{host:'127.0.0.1:19387',origin:'https://evil.invalid'})).code,200)
})
test('provider failure after real reads retains trace and reported usage as diagnostics, never advice or pass',async()=>{
 const root=fixture();try{const invoke=createAdvisor({resolveRuntime:async()=>runtime(root,{}),runLoop:async()=>({text:'',error:'provider-busy',usage:{totalTokens:9},toolCalls:1,trace:[{tool:'read',args:{path:'source.txt'},ok:true,resultAvailable:true,evidence:{path:'source.txt',sha256:'a'.repeat(64),kind:'file',status:'ready',selectionComplete:true,startLine:1,endLine:1}}]})})
 const out=await invoke({mode:'improve_result',scope:'code',focus:'Actual object',question:'Improve actual object',files:args.files},exec)
 assert.equal(out.ok,false);assert.equal(out.partial,true);assert.equal(out.diagnosticOnly,true);assert.equal(out.improvementAvailable,false);assert.equal(out.reviewPassed,false);assert.equal(out.usage.totalTokens,9);assert.equal(out.trace.length,1)
 }finally{rmSync(root,{recursive:true,force:true})}
})


test('interrupted source follow-up still counts the image observation cost and preserves it as diagnostics',async()=>{
 const root=fixture();try{const invoke=createAdvisor({resolveRuntime:async()=>runtime(root,{stream:()=>stream(report('unverified',['I0'],{gapKind:'source'}))}),runLoop:async()=>({text:'',error:'provider-busy',usageSum:{totalTokens:7},trace:[]})})
 const out=await invoke(args,exec);assert.equal(out.ok,false);assert.equal(out.usage.totalTokens,12);assert.equal(out.visualObservation.checks[0].gapKind,'source');assert.equal(out.reviewPassed,false);assert.equal(out.diagnosticOnly,true)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('read-loop failure retains earlier paid usage and labels the missing call report unknown',async()=>{
 const root=fixture();let calls=0;try{const llm={stream:()=>{if(++calls===2)throw Error('provider-busy');return(async function*(){yield{type:'block-end',block:{type:'tool-call',id:'read1',name:'read',arguments:JSON.stringify({path:'source.txt',startLine:1,endLine:1})}};yield{type:'usage',usage:{totalTokens:5}};yield{type:'finish',reason:{kind:'tool-calls'}}})()}}
 const out=await runReadOnlyToolLoop({llm,cfg:{provider:'offline',model:'test'},root,system:'Read actual source.',messages:[{role:'user',content:[{type:'text',text:'Read.'}]}],rootListing:false,budgetMs:null,shape:loopShape})
 assert.equal(out.ok,false);assert.equal(out.usageSum.totalTokens,5);assert.equal(out.usageKnownCalls,1);assert.equal(out.usageUnknownCalls,1);assert.equal(out.usageComplete,false);assert.equal(out.trace.length,1)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('read rounds preserve exact native blocks and replay state on the same configured route',async()=>{
 const root=fixture();let calls=0,second;const replay={response:{kind:'deepseek-messages',version:1,model:'m'},blocks:[{type:'reasoning',signature:'ACTUAL_FAKE_SIGNATURE'},{type:'text'},{type:'tool-call'}]}
 const content=[{type:'reasoning',text:'Opaque provider response fixture.'},{type:'text',text:'Reading the relevant line.'},{type:'tool-call',id:'read1',name:'read',arguments:JSON.stringify({path:'source.txt',startLine:1,endLine:1})}]
 try{const llm={stream:o=>{if(++calls===1)return(async function*(){for(const [index,block]of content.entries())yield{type:'block-end',index,block};yield{type:'usage',usage:{totalTokens:5}};yield{type:'finish',reason:{kind:'tool-calls'},replayState:replay}})();second=o;return stream({intent:{text:'Complete',relation:'continue'},add:[]})}}
 const out=await runReadOnlyToolLoop({llm,cfg:{provider:'p',model:'m',reasoningEffort:'max'},root,system:'Read actual source.',messages:[{role:'user',content:[{type:'text',text:'Read.'}]}],rootListing:false,budgetMs:null,shape:loopShape})
 assert.equal(out.ok,true);const native=second.messages.find(m=>m.role==='assistant');assert.deepEqual(native.content,content);assert.deepEqual(native.source.replayState,replay);assert.equal(native.source.provider,'p');assert.equal(native.source.model,'m');assert.equal(second.reasoningEffort,'max')
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('a complete stream with malformed advice JSON stays diagnostic and never records usable advice',async()=>{
 const invoke=createAdvisor({resolveRuntime:async()=>({ok:true,readTools:false,cfg:{provider:'offline',model:'m'},llm:{stream:()=>stream({not:'the-report'})}})})
 const out=await invoke({mode:'improve_result',question:'Improve actual current text',currentResult:'Actual current text'},exec)
 // 2026-10-18 新契约：格式坏了也把正文送回去（降级采纳），但绝不冒充改进或验收。
 assert.equal(out.ok,true,'格式坏了也要有答复')
 assert.equal(out.degraded,true)
 assert.equal(out.adviceReady,true)
 assert.equal(out.improvementAvailable,false,'降级答复不得冒充改进')
 assert.equal(out.reviewPassed,false)
 assert.ok(out.raw)
})

test('nonempty invalid support retains frozen visible defects in direct and staged state without accepting the call',async()=>{
 const root=fixture();try{for(const staged of [false,true])for(const bad of ['{broken',JSON.stringify({not:'a report'})]){
  const stages=staged?createAdvisorStages():null
  let stageArgs={}
  if(stages){const task=stages.startTask({sessionId:'loop-s',title:'Actual object',sourceRequestId:'human:1',sourceText:'Original required object and actual quality.'});const stage=stages.defineStage({sessionId:'loop-s',taskId:task.taskId,scope:'geometry',focus:args.focus,criteria:['Actual object relationship'],subjectPaths:['source.txt']});stageArgs={taskId:task.taskId,stageId:stage.stage.id}}
  const observed=report('failed',['I0']);observed.findings=[{text:'A visible overlapping part.',evidenceRefs:['I0'],needsSource:true}]
  const invoke=createAdvisor({stages,resolveRuntime:async()=>runtime(root,{stream:()=>stream(observed)}),runLoop:async()=>({text:bad,trace:[],usageSum:{totalTokens:7}})})
  const out=await invoke({...args,...stageArgs},exec)
  // 第二阶段报告坏了：正文降级采纳，但冻结的视觉失败保留，整次仍标 partial、不可验收。
  assert.equal(out.ok,true);assert.equal(out.degraded,true);assert.equal(out.partial,true);assert.equal(out.visualObservation.checks[0].status,'failed');assert.equal(out.reviewPassed,false);assert.equal(out.usage.totalTokens,12)
  assert.ok(out.openIssues.some(c=>c.status==='failed'),'first independent visible failure remains an open issue')
  if(staged){assert.equal(out.stageState.stage.checks[0].status,'failed');assert.equal(out.stageState.advanceAllowed,false)}
 }}finally{rmSync(root,{recursive:true,force:true})}
})

test('explicit error/aborted/max-token finish cannot turn a valid image or plain JSON report into pass',async()=>{
 const root=fixture();try{for(const kind of ['error','aborted','max-tokens'])for(const visual of [true,false]){
  const llm={stream:()=>(async function*(){yield{type:'text-delta',text:JSON.stringify(report('satisfied',[visual?'I0':'R0']))};yield{type:'usage',usage:{totalTokens:5}};yield{type:'finish',reason:{kind,failure:{code:'provider-error'}}}})()}
  const invoke=createAdvisor({resolveRuntime:async()=>visual?runtime(root,llm):({ok:true,readTools:false,cfg:{provider:'p',model:'m'},llm})})
  const out=await invoke(visual?args:{mode:'improve_result',question:'Improve current',currentResult:'Actual result'},exec)
  assert.equal(out.reviewPassed,false);assert.equal(out.partial,true);assert.equal(out.adviceReady,false);assert.equal(out.usage.totalTokens,5);assert.equal(out.usageKnownCalls,1)
 }}finally{rmSync(root,{recursive:true,force:true})}
})
test('first image missing usage is counted unknown even if the source phase reports complete usage',async()=>{
 const root=fixture();try{const llm={stream:()=>(async function*(){yield{type:'text-delta',text:JSON.stringify(report('unverified',['I0'],{gapKind:'source'}))};yield{type:'finish',reason:{kind:'stop'}}})()}
 const invoke=createAdvisor({resolveRuntime:async()=>runtime(root,llm),runLoop:async()=>({text:JSON.stringify(report('satisfied',['I0','F0'])),trace:[],usageSum:{totalTokens:7},usageComplete:true,usageKnownCalls:1,usageUnknownCalls:0})})
 const out=await invoke(args,exec);assert.equal(out.usage.totalTokens,7);assert.equal(out.usageComplete,false);assert.equal(out.usageKnownCalls,1);assert.equal(out.usageUnknownCalls,1)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('a thrown support adapter retains the first independent visible defect and unknown support cost',async()=>{
 const root=fixture();try{const observed=report('failed',['I0']);observed.findings=[{text:'Visible intersection.',evidenceRefs:['I0'],needsSource:true}]
 const invoke=createAdvisor({resolveRuntime:async()=>runtime(root,{stream:()=>stream(observed)}),runLoop:async()=>{throw Error('support-adapter-threw')}})
 const out=await invoke(args,exec);assert.equal(out.ok,false);assert.equal(out.visualObservation.checks[0].status,'failed');assert.ok(out.openIssues.some(c=>c.status==='failed'));assert.equal(out.usage.totalTokens,5);assert.equal(out.usageComplete,false);assert.equal(out.usageKnownCalls,1);assert.equal(out.usageUnknownCalls,1)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('a report that cites unverifiable support is degraded, not discarded',async()=>{
 const root=fixture();try{
  const bad=JSON.stringify(report('satisfied',['FAKE']))
  const invoke=createAdvisor({resolveRuntime:async()=>runtime(root,{stream:()=>stream(report('failed',['I0']))}),runLoop:async()=>({text:bad,trace:[],usageSum:{totalTokens:7}})})
  const out=await invoke({...args},exec)
  assert.equal(out.ok,true,'答复必须到达调用方（这是本次要修的）')
  assert.equal(out.reviewPassed,false,'撑不住的 satisfied 绝不许过')
  assert.ok(!JSON.stringify(out.report??{}).includes('FAKE'),'无效引用必须从返回的报告里消失')
  assert.equal(out.usage.totalTokens,5)
 }finally{rmSync(root,{recursive:true,force:true})}
})
