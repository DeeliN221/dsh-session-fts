import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {apply} from '../index.js'

test('actual status route admits the new core and refuses auth failures without escaping as HTTP400',async t=>{
 const root=mkdtempSync(join(tmpdir(),'fts-http-auth-')),disposers=[];let route,connection;
 const ctx={sessions:{get:()=>undefined},sessionQuery:{listSessions:async()=>[]},tools:{register:()=>()=>{}},
  get:()=>undefined,on:()=>{},effect(fn){const d=fn();if(typeof d==='function')disposers.push(d)},
  inject(names,fn){if(names.includes('webServer'))fn({...ctx,get connection(){return connection},
   webServer:{register(value){route=value;return()=>{route=undefined}}}})}};
 t.after(async()=>{for(const d of disposers.reverse())await d();assert(root.startsWith(join(tmpdir(),'fts-http-auth-')));rmSync(root,{recursive:true,force:true})});
 await apply(ctx,{path:join(root,'search.sqlite'),startupDelayMs:600000,refreshIntervalMs:0,semantic:{enabled:false}});
 const peer={principal:{kind:'owner'},signal:new AbortController().signal};
 const cases=[[{admit:()=>({peer})},200],[{admit:()=>({rejection:401})},401],[{admit:()=>({rejection:403})},403],
  [{admit:()=>({rejection:503})},503],[{admit(){throw new Error('fixture')}},403],[{},403],
  [{admit:()=>null},403],[{requestRejection:()=>undefined},200],[{requestRejection:()=>403},403]];
 for(const [next,status] of cases){connection=next;let actual,body;
  const res={writeHead(code){actual=code},end(data){body=JSON.parse(data)}};
  await route.handler({method:'GET',url:'/session-fts/api/status',headers:{host:'dsh.example',origin:'https://dsh.example'}},res);
  assert.equal(actual,status);assert.equal(body.ok,status===200);
 }
})
