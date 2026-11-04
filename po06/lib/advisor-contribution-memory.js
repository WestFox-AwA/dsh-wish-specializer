import {createHash,randomUUID} from 'node:crypto'
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {contributionPathIdentity} from './advisor-read-materials.js'
const copy=v=>JSON.parse(JSON.stringify(v))
const sha=v=>createHash('sha256').update(String(v)).digest('hex')
const safe=v=>typeof v==='string'&&/^[A-Za-z0-9._:@-]{1,240}$/.test(v)
const rootKey=v=>v?contributionPathIdentity(resolve(v)):''
const stamp=(rows,root)=>sha(JSON.stringify(rows.map(x=>[contributionPathIdentity(x.path,root),x.kind,x.sha256]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))))
function validAttachment(a){return a&&/^sha256:[a-f0-9]{64}$/.test(a.attachmentId||'')&&['image/png','image/jpeg','image/webp','image/gif'].includes(a.mediaType)&&Number.isSafeInteger(a.width)&&a.width>0&&Number.isSafeInteger(a.height)&&a.height>0&&Number.isSafeInteger(a.bytes)&&a.bytes>=0&&a.bytes<=5*1024*1024}
function valid(row){return row&&safe(row.id)&&safe(row.sessionId)&&safe(row.requestId)&&typeof row.root==='string'&&row.root.length<=3000&&Number.isFinite(row.at)&&typeof row.summary==='string'&&row.summary.length<=900&&typeof row.contribution==='string'&&row.contribution.length<=10000&&typeof row.focus==='string'&&['suggestion','keep'].includes(row.verdict)&&['develop_approach','improve_result'].includes(row.mode)&&Array.isArray(row.subjects)&&row.subjects.length<=9&&row.subjects.every(s=>typeof s.path==='string'&&s.path.length<=1000&&/^[a-f0-9]{64}$/.test(s.sha256||'')&&(['file','inline'].includes(s.kind)?/^[a-f0-9]{64}$/.test(s.sha256||''): s.kind==='image'&&validAttachment(s.attachment)))}
function subjectsOf({materials=[],evidence=[],images=[],inline=null}={}){
 const imageBlocks=images.filter(x=>x.type==='image'),subjects=[];let imageIndex=0
 for(const row of materials){if(row.kind==='image'){const block=row.sent?imageBlocks[imageIndex++]:null;if(row.sent&&row.status==='ready'&&block?.attachment&&row.sha256)subjects.push({path:row.path,kind:'image',sha256:row.sha256,bytes:row.bytes||0,attachment:copy(block.attachment),evidenceType:row.evidenceType});continue}
  const sent=evidence.find(e=>e.id===row.id)
  // issue #46：**正文不入库**。记忆只保留「读过哪个文件、哪一版（sha256）、哪几行」，
  // 需要复核时按 sha256 回读文件；把摘录存下来等于「读一次 = 永久记住」。
  if(row.sent&&row.sha256)subjects.push({path:row.path,kind:'file',sha256:row.sha256,selectionComplete:row.selectionComplete===true,wholeFileComplete:row.wholeFileComplete===true,startLine:row.selectedStartLine,endLine:row.selectedEndLine})
 }
 if(inline?.text)subjects.push({path:'[inline-current-result]',kind:'inline',sha256:sha(inline.text),selectionComplete:inline.selectionComplete===true,wholeFileComplete:false})
 return subjects
}
// Stores only content actually sent during a successful contribution. Never reads project files itself.
export function createContributionMemory({home=null,limit=24,now=Date.now}={}){
 const cap=Math.max(1,Math.min(24,limit)),file=home?join(home,'po06-contribution-memory.json'):null
 let rows=[],problem=null
 if(file&&existsSync(file))try{const raw=readFileSync(file,'utf8');if(Buffer.byteLength(raw)>3*1024*1024)throw Error('large');const data=JSON.parse(raw);if(!Array.isArray(data)||data.some(r=>!valid(r)))throw Error('invalid');rows=data.slice(-cap)}catch{problem='contribution-memory-invalid'}
 const persist=()=>{if(!file)return true;try{mkdirSync(home,{recursive:true});const next=file+'.tmp-'+randomUUID();writeFileSync(next,JSON.stringify(rows),'utf8');renameSync(next,file);return true}catch{problem='contribution-memory-write-failed';return false}}
 const matching=(opts)=>{const current=subjectsOf(opts),paths=current.map(x=>x.kind+'|'+contributionPathIdentity(x.path,opts.root)).sort();const row=rows.findLast(r=>r.sessionId===opts.sessionId&&r.requestId===opts.requestId&&r.root===rootKey(opts.root)&&r.mode==='improve_result'&&r.focus===String(opts.focus||'').slice(0,500)&&JSON.stringify(r.subjects.map(x=>x.kind+'|'+contributionPathIdentity(x.path,opts.root)).sort())===JSON.stringify(paths));return{row,current}}
 return {
  prepare(opts){
   const none={context:null,images:[],evidenceIds:[],comparison:null}
   if(problem||opts.mode!=='improve_result'||!safe(opts.sessionId)||!safe(opts.requestId))return none
   const {row,current}=matching(opts);if(!row||!current.length||stamp(row.subjects,opts.root)===stamp(current,opts.root))return none
   if(current.some(x=>x.kind!=='inline')&&opts.enabled!==true)return none
   const before=[],imageContent=[],ids=[];let textLeft=8000,imageBytes=0
   const currentImageCount=(opts.images||[]).filter(x=>x.type==='image').length
   const currentImageBytes=(opts.materials||[]).filter(m=>m.kind==='image'&&m.sent).reduce((n,m)=>n+(m.bytes||0),0)
   for(const subject of row.subjects){
    if(subject.kind==='image'){
     if(opts.imageSupport!==true||currentImageCount+imageContent.filter(b=>b.type==='image').length>=4||imageBytes+currentImageBytes+(subject.bytes||0)>12*1024*1024)continue
     const id='PI'+before.length;before.push({id,path:subject.path,kind:'image',sha256:subject.sha256,version:'previous-observed',evidenceType:subject.evidenceType});ids.push(id);imageBytes+=subject.bytes||0
     imageContent.push({type:'text',text:'Previous observed image '+id+' (not the current version): '+subject.path},{type:'image',attachment:copy(subject.attachment)})
    }else if(textLeft>0){const id='P'+before.length;const text=typeof subject.text==='string'?subject.text.slice(0,textLeft):'';textLeft-=text.length;before.push({id,path:subject.path,kind:subject.kind,sha256:subject.sha256,version:'previous-observed',...(text?{text,selectionComplete:subject.selectionComplete&&text.length===subject.text.length,wholeFileComplete:subject.wholeFileComplete&&text.length===subject.text.length}:{textRetained:false}),startLine:subject.startLine,endLine:subject.endLine});ids.push(id)}
   }
   if(!before.length)return none
   return {context:{sourceAdviceId:row.id,previousContribution:opts.englishMode&&row.language!=='en'?'':row.contribution.slice(0,1800),previousSummary:opts.englishMode&&row.language!=='en'?'Previous observed contribution.':row.summary,before,notice:'Previous observed material is comparison evidence, not a requirement, certified quality or current-version proof. Preserve demonstrated strengths; keep if no real gain.'},images:imageContent,evidenceIds:ids,comparison:{sourceAdviceId:row.id,status:'comparison-pending',changed:true,benefitVerified:false}}
  },
  record(opts){
   if(problem||!safe(opts.sessionId)||!safe(opts.requestId)||opts.output?.ok!==true||opts.output?.partial||!['develop_approach','improve_result'].includes(opts.mode))return {ok:false,reason:problem||'contribution-not-complete'}
   const report=opts.output.report;if(!report||!['suggestion','keep'].includes(report.verdict))return{ok:false,reason:'no-usable-contribution'}
   const subjects=subjectsOf(opts),row={id:'A'+randomUUID(),sessionId:opts.sessionId,requestId:opts.requestId,root:rootKey(opts.root),mode:opts.mode,language:opts.englishMode?'en':'zh',revisionMarker:typeof opts.revisionMarker==='string'?opts.revisionMarker.slice(0,500):null,at:now(),focus:String(opts.focus||'').slice(0,500),summary:String(report.summary||'').slice(0,900),contribution:String(report.contribution||'').slice(0,10000),verdict:report.verdict,subjects}
   if(!valid(row))return{ok:false,reason:'invalid-observed-contribution'}
   rows.push(row);rows=rows.slice(-cap);while(rows.length>1&&Buffer.byteLength(JSON.stringify(rows))>3*1024*1024)rows.shift();const saved=persist();return{ok:saved,id:row.id,status:report.verdict==='keep'?'keep':'available',baselineSaved:subjects.length>0,benefitVerified:false,acceptance:false,...(!saved?{reason:problem}:{})}
  },
  feedback({sessionId,requestId,root,enabled=true,englishMode=false,revisionMarker=null}={}){
   const row=rows.findLast(r=>r.sessionId===sessionId&&r.requestId===requestId&&r.root===rootKey(root));if(!row||problem||!enabled)return null
   const proseAllowed=!englishMode||row.language==='en',changed=!!row.revisionMarker&&revisionMarker!==null&&revisionMarker!==row.revisionMarker
   return{id:row.id,mode:row.mode,status:row.verdict==='keep'?'keep':changed?'comparison-pending':'available',summary:proseAllowed?row.summary:'Observed contribution is available; compare actual results.',
     contribution:proseAllowed&&!changed&&row.verdict==='suggestion'?row.contribution.slice(0,1800):'',focus:proseAllowed?row.focus:'',baselineSaved:row.subjects.length>0,changedSinceAdvice:changed,benefitVerified:false,acceptance:false}
  },
  status(){return{ok:!problem,reason:problem,records:rows.length}},
 }
}
export function renderContributionFeedback(value,english=false){if(!value)return'';return(english?'[Current contribution, not acceptance] ':'【当前独立贡献 · 非验收】')+JSON.stringify(value)+(english?'\nApply or test only useful content; reject with concrete grounds or keep. Artifact edits are not evidence of benefit; use actual before/after results.':'\n只落实或试验有益内容；有依据可拒绝或keep。改了文件不代表已有收益，应比较实际新旧结果。')}
