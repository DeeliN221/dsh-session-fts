import {requestRejection} from '../host/http-auth.js';
const verdict=requestRejection;
import test from 'node:test';
import assert from 'node:assert/strict';
const owner=()=>({principal:{kind:'owner'},signal:new AbortController().signal});
const request=()=>({headers:{host:'dsh.example',origin:'https://dsh.example'},socket:{remoteAddress:'127.0.0.1',destroyed:false}});
const modern=()=>({admit(){throw new Error('must never re-authenticate in the route')}});
test('server-admitted live owner passes without invoking nested authentication',()=>{
 assert.equal(verdict(request(),modern,owner()),undefined);
});
test('missing, malformed, non-owner and aborted server peers fail closed without legacy fallback',()=>{
 const stopped=new AbortController();stopped.abort();
 for(const peer of [undefined,null,{},false,{principal:{kind:'owner'}},{principal:{kind:'guest'},signal:new AbortController().signal},
  {principal:{kind:'owner'},signal:stopped.signal},{get principal(){throw new Error('bad peer')}}]){
  assert.equal(verdict(request(),()=>({...modern(),requestRejection:()=>undefined}),peer),403);
 }
});
test('untrusted body and header peer claims cannot replace the server argument',()=>{
 const req=request();req.peer=owner();req.body={peer:owner()};req.headers.peer='owner';
 assert.equal(verdict(req,modern),403);
});
test('unknown interface, lookup exception and throwing capability getters never downgrade',()=>{
 const fail=()=>{throw new Error('fixture')};
 for(const get of [()=>({}),()=>({admit:42,requestRejection:()=>undefined}),()=>({get admit(){return fail()}}),fail]){
  assert.equal(verdict(request(),get,owner()),403);
 }
});
test('legacy core preserves acceptance, credential refusal and exception refusal',()=>{
 assert.equal(verdict(request(),()=>({requestRejection:()=>undefined})),undefined);
 assert.equal(verdict(request(),()=>({requestRejection:()=>401})),401);
 assert.equal(verdict(request(),()=>({requestRejection(){throw new Error('fixture')}})),403);
});
