import test from 'node:test'
import assert from 'node:assert/strict'
import { SessionRetrieval, evidenceId } from '../host/retrieval.js'
const who={userId:'u',deviceId:'mac',profile:'test'}
const hit={...who,sessionId:'s',seq:7,time:10,cwd:'/repo',role:'user',content:'星云 Nebula',createdAt:new Date(10).toISOString()};hit.id=evidenceId(hit)
const localResult={result:{sessions:[{sessionId:'s',cwd:'/repo',matches:[{seq:7,time:10,role:'user',snippet:'星云 Nebula'}]}]}}
test('shared retrieval binds user, device, profile and exact native event identity',async()=>{
 const service=new SessionRetrieval(who,async()=>localResult)
 const request={query:'Nebula',scope:'workspace',cwd:'/repo'}
 for(const key of Object.keys(who))await assert.rejects(service.search(request,{...who,[key]:'foreign'}),/scope denied/)
 await assert.rejects(service.search({query:'Nebula'},who),/scope denied/)
 assert.equal((await service.search(request,who)).hits[0].id,hit.id)
 assert.equal((await service.search({...request,excludeSessionId:'s'},who)).hits.length,0)
 assert.notEqual(evidenceId({...hit,deviceId:'work'}),hit.id)
 assert.notEqual(evidenceId({...hit,seq:8}),hit.id)
})
test('central success including empty results never fans out; only outage falls back',async()=>{
 let local=0,remote=0,result={hits:[hit,hit]},error
 const service=new SessionRetrieval(who,async()=>{local++;return localResult})
 service.registerRemote({identity:who,async search(){remote++;if(error)throw error;return result}})
 const q={query:'Nebula',scope:'workspace',cwd:'/repo',backend:'central'}
 assert.equal((await service.search(q,who)).hits.length,1);assert.equal(local,0)
 result={hits:[]};assert.equal((await service.search(q,who)).hits.length,0);assert.equal(local,0)
 error=Object.assign(new Error('offline'),{code:'OFFLINE'});assert.equal((await service.search(q,who)).fallback,'OFFLINE');assert.equal(local,1)
 error=Object.assign(new Error('denied'),{status:401});await assert.rejects(service.search(q,who));assert.equal(local,1);assert.equal(remote,4)
})

test('unmapped remote workspace and wrong event identities are rejected even if server returns them',async()=>{
 const service=new SessionRetrieval(who,async()=>localResult)
 const foreign={...hit,deviceId:'work',cwd:'/repo'};foreign.id=evidenceId(foreign)
 service.registerRemote({identity:who,workspaceScopes:()=>[{deviceId:'work',cwd:'/authorized'}],async search(){return {hits:[foreign,{...foreign,cwd:'/authorized'},{...hit,id:'forged'}]}}})
 const result=await service.search({query:'星云',scope:'workspace',cwd:'/repo',backend:'central'},who)
 assert.equal(result.hits.length,1);assert.equal(result.hits[0].cwd,'/authorized')
 assert.equal((await service.search({query:'星云',scope:'workspace',cwd:'/repo',backend:'central',from:11},who)).hits.length,0)
 await assert.rejects(service.search({query:'星云',cwd:'/repo',from:'not-a-date'},who),/INVALID_TIME/)
})
test('shared request deadline, concurrency and abort bound stalled remote providers',async()=>{
 const service=new SessionRetrieval(who,async()=>localResult,{timeoutMs:80,maxConcurrent:1})
 service.registerRemote({identity:who,search:()=>new Promise(()=>{})})
 const q={query:'Nebula',cwd:'/repo',backend:'central'}
 const first=service.search(q,who);await assert.rejects(service.search(q,who),/BUSY/)
 const result=await first;assert.equal(result.backend,'local');assert.equal(result.fallback,'TIMEOUT')
 const controller=new AbortController();const pending=service.search(q,who,controller.signal);controller.abort();await assert.rejects(pending,/ABORTED/)
 assert.equal(service.active,0)
})
