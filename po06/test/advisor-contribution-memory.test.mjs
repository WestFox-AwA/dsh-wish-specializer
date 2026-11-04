import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createContributionMemory} from '../lib/advisor-contribution-memory.js'
import {prepareAdvisorMaterials,selectMaterialExcerpt} from '../lib/advisor-materials.js'
const output=(verdict='suggestion')=>({ok:true,report:{verdict,summary:'Specific possible gain',contribution:verdict==='keep'?'':'Directly usable alternative.'}})
const base={sessionId:'s1',requestId:'human:1',root:null,enabled:true,mode:'improve_result',focus:'actual object'}
test('complete inline before-image is reused only after actual current result changed',()=>{
 const memory=createContributionMemory(),first={...base,inline:{text:'Original exact result.',selectionComplete:true}}
 const saved=memory.record({...first,output:output()});assert.equal(saved.baselineSaved,true);assert.equal(saved.benefitVerified,false)
 assert.equal(memory.prepare(first).context,null)
 const changed=memory.prepare({...base,inline:{text:'Actually changed result.',selectionComplete:true}})
 // issue #46：正文**不再入库**。比较时只给「读过哪份材料、哪一版」，正文要它自己按 sha 重读。
 assert.equal(changed.context.before[0].text,undefined,'记忆里不得保留正文');
 assert.equal(changed.context.before[0].textRetained,false);assert.ok(changed.context.before[0].sha256);
 assert.equal(changed.comparison.status,'comparison-pending');assert.equal(changed.comparison.benefitVerified,false)
 assert.equal(changed.evidenceIds[0],'P0');assert.equal(changed.images.length,0)
 assert.equal(memory.prepare({...base,requestId:'human:99',inline:{text:'Changed'}}).context,null)
 assert.equal(memory.prepare({...base,sessionId:'other',inline:{text:'Changed'}}).context,null)
})
test('baseline caches only sent excerpts, respects permission/namespace and survives reload',async()=>{
 const root=mkdtempSync(join(tmpdir(),'contribution-memory-'))
 try{const home=join(root,'state'),path=join(root,'actual.txt'),text='HEAD OBSERVED\n'+'middle material\n'.repeat(800)+'UNREAD_MIDDLE_SECRET\n'+'tail context\n'.repeat(900)+'TAIL OBSERVED\n';writeFileSync(path,text)
 const bundle=await prepareAdvisorMaterials({args:{files:[{path:'actual.txt',purpose:'actual result'}]},root,enabled:true})
 assert.equal(bundle.materials[0].status,'truncated');assert.ok(bundle.evidence[0].text.includes('TAIL OBSERVED'));assert.equal(bundle.evidence[0].text.includes('UNREAD_MIDDLE_SECRET'),false)
 const memory=createContributionMemory({home}),opts={...base,root,...bundle};memory.record({...opts,output:output()})
 writeFileSync(path,'Changed actual file.');const now=await prepareAdvisorMaterials({args:{files:[{path:'actual.txt',purpose:'actual result'}]},root,enabled:true})
 const loaded=createContributionMemory({home});const next=loaded.prepare({...base,root,...now})
 assert.ok(next.context);assert.equal(JSON.stringify(next.context).includes('UNREAD_MIDDLE_SECRET'),false)
 assert.equal(loaded.prepare({...base,root,...now,enabled:false}).context,null)
 assert.equal(loaded.prepare({...base,root:join(root,'another'),...now}).context,null)
 assert.equal(loaded.prepare({...base,root,...now,requestId:'human:2'}).context,null)
 const cache=readFileSync(join(home,'po06-contribution-memory.json'),'utf8');assert.equal(cache.includes('UNREAD_MIDDLE_SECRET'),false)
 }finally{rmSync(root,{recursive:true,force:true})}
})
test('keep, interrupted and corrupt records cannot create acceptance or baseline proof',()=>{
 const memory=createContributionMemory(),opts={...base,inline:{text:'Actual',selectionComplete:true}}
 const keep=memory.record({...opts,output:output('keep')});assert.equal(keep.status,'keep');assert.equal(keep.acceptance,false)
 assert.equal(memory.record({...opts,output:{...output(),partial:true}}).ok,false)
 const root=mkdtempSync(join(tmpdir(),'memory-invalid-'));try{writeFileSync(join(root,'po06-contribution-memory.json'),'[{}]');const bad=createContributionMemory({home:root});assert.equal(bad.status().ok,false);assert.equal(bad.prepare({...opts,inline:{text:'New'}}).context,null)}finally{rmSync(root,{recursive:true,force:true})}
})
test('bounded excerpts retain real head/tail and never fabricate a complete oversized line',()=>{
 const text='head\n'+'x\n'.repeat(900)+'tail\n',out=selectMaterialExcerpt(text,600,21)
 assert.ok(out.content.startsWith('head\n'));assert.ok(out.content.endsWith('tail\n'));assert.ok(out.content.length<=600);assert.equal(out.ranges.length,2);assert.ok(out.ranges[0].endLine<out.ranges[1].startLine)
 const huge=selectMaterialExcerpt('x'.repeat(18000),16000);assert.equal(huge.ranges.length,0);assert.equal(huge.partialLine,true)
})

test('English comparison keeps literal prior artifact data but not earlier Chinese collaboration prose',()=>{
 const memory=createContributionMemory(),prior={...base,englishMode:false,inline:{text:'原始实际产物',selectionComplete:true}}
 memory.record({...prior,output:{ok:true,report:{verdict:'suggestion',summary:'先前中文顾问叙述',contribution:'先前中文方法'}}})
 const current=memory.prepare({...base,englishMode:true,inline:{text:'Changed actual artifact.',selectionComplete:true}})
 // issue #46：跨语言比较同样不再携带正文，只保留引用（sha256 标识的那一版）
 assert.equal(current.context.before[0].text,undefined);assert.equal(current.context.before[0].textRetained,false);
 assert.equal(current.context.previousContribution,'');assert.equal(current.context.previousSummary,'Previous observed contribution.')
 assert.equal(memory.feedback({...base,englishMode:true}).summary,'Observed contribution is available; compare actual results.')
})

test('a different review focus does not anchor the new comparison to earlier advice on the same file',()=>{
 const memory=createContributionMemory();memory.record({...base,inline:{text:'Original observed result.',selectionComplete:true},output:output()})
 assert.equal(memory.prepare({...base,focus:'Different original question',inline:{text:'Changed actual material.',selectionComplete:true}}).context,null)
 assert.equal(memory.feedback({...base}).focus,base.focus)
})

test('working context carries actual usable contribution until source changes, without pretending adoption or gain',()=>{
 const memory=createContributionMemory();memory.record({...base,revisionMarker:'write:1',inline:{text:'Original artifact.',selectionComplete:true},output:output()})
 const before=memory.feedback({...base,revisionMarker:'write:1'});assert.equal(before.contribution,'Directly usable alternative.');assert.equal(before.status,'available');assert.equal(before.acceptance,false)
 const after=memory.feedback({...base,revisionMarker:'write:2'});assert.equal(after.status,'comparison-pending');assert.equal(after.contribution,'');assert.equal(after.changedSinceAdvice,true);assert.equal(after.benefitVerified,false)
})
