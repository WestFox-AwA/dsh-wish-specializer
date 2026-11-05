import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as sdk from './fixtures/llm-lib-017.mjs'
import { runReadOnlyToolLoop } from '../lib/read-tools.js'

const done = (kind = 'stop', replayState) => ({ type:'finish', reason:{kind}, ...(replayState ? {replayState} : {}) })
const call = (id, name, args) => ({ type:'block-end', block:{type:'tool-call',id,name,arguments:JSON.stringify(args)} })
const answer = JSON.stringify({intent:{text:'Use the authorized task and available evidence.',relation:'new'},add:['Keep the result coherent.'],scaffold:[],ask:[]})
function setup(t, respond) {
  const root=mkdtempSync(join(tmpdir(),'optimizer-continuation-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  writeFileSync(join(root,'note.txt'),'authorized evidence\n')
  const calls=[]
  const llm={stream(options){calls.push(options);return (async function*(){for(const chunk of respond(options,calls.length))yield chunk})()}}
  const options={root,llm,cfg:{provider:'p',model:'m'},system:'Return the requested JSON.',messages:[sdk.createUserMessage({content:[{type:'text',text:'The exact original task.'}],source:{kind:'user'}})],shape:sdk,rootListing:false}
  return {root,llm,calls,options}
}

test('a mixed successful/rejected batch and native thinking replay reach the final answer together',async t=>{
  const thinking={type:'reasoning',text:'Read only authorized evidence.',signature:'opaque-signature'}
  const replay={opaque:'provider replay metadata'}
  const first=[{type:'block-end',index:0,block:thinking},call('good','read',{path:'note.txt'}),call('denied','run',{command:'which node 2>/dev/null'}),{type:'usage',usage:{totalTokens:8}},done('tool-calls',replay)]
  const h=setup(t,(_o,n)=>n===1?first:[{type:'text-delta',text:answer},{type:'usage',usage:{totalTokens:13}},done()])
  const original=h.options.messages.slice()
  const out=await runReadOnlyToolLoop(h.options)
  assert.equal(out.ok,true,out.error);assert.equal(out.text,answer)
  assert.equal(h.calls.length,2);assert.equal(out.rounds,2);assert.equal(out.toolCalls,2)
  assert.equal(out.usageSum.totalTokens,21);assert.equal(out.usageKnownCalls,2)
  assert.equal(out.trace[0].ok,true);assert.equal(out.trace[1].rejected,true)
  assert.ok(h.calls[0].tools);assert.equal(h.calls[1].tools,undefined,'默认策略：一次拒绝即收口（优化器的真实回放夹具锁着这条）')
  assert.equal(h.calls[0].messages.length,1,'earlier request arrays do not mutate during continuation')
  assert.deepEqual(h.options.messages,original,'caller task history is not mutated')
  const messages=h.calls[1].messages
  const assistant=messages.find(m=>m.role==='assistant')
  assert.equal(assistant.content[0],thinking,'preserve provider reasoning block/signature')
  assert.deepEqual(assistant.source.replayState,replay)
  const results=messages.filter(m=>m.role==='tool')
  assert.deepEqual(results.map(m=>m.toolCallId),['good','denied'])
  assert.equal(results[0].isError,false);assert.match(results[0].content[0].text,/authorized evidence/)
  assert.equal(results[1].isError,true);assert.match(results[1].content[0].text,/拒绝/)
  assert.equal(messages[0],original[0]);assert.equal(h.calls[1].system,h.calls[0].system)
})

test('ordinary successful lookups continue with tools and never reset their history',async t=>{
  const h=setup(t,(_o,n)=>n===1?[call('r','read',{path:'note.txt'}),done('tool-calls')]:[{type:'text-delta',text:answer},done()])
  const out=await runReadOnlyToolLoop(h.options)
  assert.equal(out.ok,true,out.error);assert.equal(h.calls.length,2)
  assert.ok(h.calls[1].tools,'one successful lookup does not disable remaining authorized lookups')
  assert.equal(h.calls[1].messages.at(-1).role,'tool')
  assert.equal(h.calls[1].messages.at(-1).toolCallId,'r')
  assert.equal(out.capped,false)
})

for(const reason of ['round limit','lookup budget'])test(reason+' finishes in the same history exactly once',async t=>{
  let clock=0
  const h=setup(t,(_o,n)=>{
    if(n===1){clock=2000;return [call('r','read',{path:'note.txt'}),done('tool-calls')]}
    return [{type:'text-delta',text:answer},done()]
  })
  const out=await runReadOnlyToolLoop({...h.options,count:reason==='round limit'?1:3,budgetMs:1000,now:()=>clock})
  assert.equal(out.ok,true,out.error);assert.equal(h.calls.length,2)
  assert.equal(h.calls[1].tools,undefined);assert.equal(out.capped,true)
  assert.equal(h.calls[1].messages.filter(m=>m.role==='tool').length,1)
  assert.equal(h.calls[1].messages.at(-1).role,'user','request final answer after tool results')
})

test('unsupported tool-result format fails before tools are advertised or a paid call starts',async t=>{
  const h=setup(t,()=>{throw new Error('must not call the model')})
  const out=await runReadOnlyToolLoop({...h.options,shape:{}})
  assert.equal(out.ok,false);assert.equal(out.error,'tool-result-format-unavailable')
  assert.equal(h.calls.length,0);assert.equal(out.text,'')
})

test('cancelling after a rejected result prevents the final model request',async t=>{
  const ac=new AbortController()
  const h=setup(t,()=>[call('denied','run',{command:'which node'}),done('tool-calls')])
  const out=await runReadOnlyToolLoop({...h.options,signal:ac.signal,onEvent:event=>{if(event.kind==='tool')ac.abort()}})
  assert.equal(out.ok,false);assert.equal(out.error,'cancelled')
  assert.equal(h.calls.length,1);assert.equal(out.trace.length,1)
})

test('two consecutive rejected rounds finalize, and a tool call during finalization fails without executing',async t=>{
  // 连续两轮都被拒绝 ⇒ 收口（防止模型在非法写法上原地打转）；此后若仍要调工具就是协议错误。
  const h=setup(t,(_o,n)=>{
    if(n===1)return [call('denied','run',{command:'which node'}),done('tool-calls')]
    if(n===2)return [call('denied2','run',{command:'which npm'}),done('tool-calls')]
    return [call('extra','read',{path:'note.txt'}),done('tool-calls')]
  })
  // 顾问使用的策略：拒绝可以被改正一次，连续两轮才收口
  const out=await runReadOnlyToolLoop({ ...h.options, rejectPolicy: 'retry-once' })
  assert.equal(out.ok,false);assert.equal(out.error,'tool-calls-after-finalization')
  assert.equal(h.calls.length,3)
  assert.equal(out.toolCalls,2,'two rejected calls executed; the final request is not executed')
})

test('顾问策略：一次被拒后仍可继续查证（retry-once）', async (t) => {
  // ollama ds41f 习惯写 `… | head`，会被虚拟 POSIX 拒绝；拒绝只是"这条写法不合法"，
  // 把理由回灌给模型再试一次，而不是立刻结束整轮查证。
  const h = setup(t, (_o, n) => {
    if (n === 1) return [call('denied', 'run', { command: 'which node' }), done('tool-calls')]
    if (n === 2) return [call('good', 'read', { path: 'note.txt' }), done('tool-calls')]
    return [{ type: 'text-delta', text: answer }, done()]
  })
  const out = await runReadOnlyToolLoop({ ...h.options, rejectPolicy: 'retry-once' })
  assert.equal(out.ok, true, out.error)
  assert.equal(h.calls.length, 3, '被拒之后还有一次改正机会')
  assert.ok(h.calls[1].tools, '第二回合仍然可以调工具')
  assert.equal(out.trace[0].rejected, true)
  assert.equal(out.trace[1].ok, true)
  assert.equal(out.text, answer)
})
