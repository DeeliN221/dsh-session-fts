import {requestRejection} from '../host/http-auth.js';
const verdict=requestRejection;
import test from 'node:test';
import assert from 'node:assert/strict';
const peer = () => ({principal: {kind: 'owner'}, signal: new AbortController().signal});
const request = () => ({headers: {host: 'dsh.example', origin: 'https://dsh.example', cookie: 'fixture=valid'},
  socket: {remoteAddress: '192.0.2.20', destroyed: false}, method: 'GET', url: '/status'});

test('new admission accepts only a live owner and receives the exact request', () => {
  const req = request(); let seen;
  const result = verdict(req, () => ({admit(value) {seen=value; return {peer: peer()};}}));
  assert.equal(result, undefined); assert.equal(seen, req);
});
for (const status of [401,403,503]) test(`new admission preserves refusal ${status} without legacy downgrade`, () => {
  assert.equal(verdict(request(), () => ({admit: () => ({rejection: status}), requestRejection: () => undefined})),status);
});
test('malformed admission, foreign or incomplete peer, aborted peer and unknown interfaces fail closed', () => {
  const stopped = new AbortController(); stopped.abort();
  const values=[undefined,null,false,{},[],Promise.resolve({peer:peer()}),{rejection:0,peer:peer()},
    {peer:{principal:{kind:'guest'},signal:new AbortController().signal}},
    {peer:{principal:{kind:'owner'}}},{peer:{principal:{kind:'owner'},signal:stopped.signal}}];
  for(const value of values) assert.equal(verdict(request(),()=>({admit:()=>value})),403);
  for(const connection of [{},{admit:42,requestRejection:()=>undefined}]) assert.equal(verdict(request(),()=>connection),403);
});
test('admission method, property and service lookup exceptions fail closed', () => {
  const fail=()=>{throw new Error('fixture exception')};
  assert.equal(verdict(request(),()=>({admit:fail})),403);
  assert.equal(verdict(request(),()=>({get admit(){return fail()}})),403);
  assert.equal(verdict(request(),fail),403);
});
test('legacy requestRejection acceptance and refusal remain supported', () => {
  assert.equal(verdict(request(),()=>({requestRejection:()=>undefined})),undefined);
  assert.equal(verdict(request(),()=>({requestRejection:()=>401})),401);
  assert.equal(verdict(request(),()=>({requestRejection(){throw new Error('fixture')}})),403);
});
test('new admission applies Host, Origin and invalid-cookie refusals', () => {
  const connection={admit(req){
    if(req.headers.host!=='dsh.example'||req.headers.origin!=='https://dsh.example')return {rejection:403};
    return req.headers.cookie==='fixture=valid'?{peer:peer()}:{rejection:401};
  }};
  for(const field of ['host','origin']){const req=request();req.headers[field]='https://other.example';assert.equal(verdict(req,()=>connection),403);}
  const req=request();req.headers.cookie='fixture=invalid';assert.equal(verdict(req,()=>connection),401);
});
test('actual core HostConnectionService.admit retains source policy and authentication', {skip:!process.env.DSH_CONNECTION_MODULE},async()=>{
  const {HostConnectionService}=await import(process.env.DSH_CONNECTION_MODULE);
  const connection=Object.create(HostConnectionService.prototype);
  connection.owner={get:()=>({host:'192.0.2.10',protocol:'http:'})};
  connection.trustedHosts=['dsh.example']; connection.disposed=false;
  connection.authentication={authenticate(req){return req.headers.cookie==='fixture=valid'?{peer:peer()}:{rejection:401};}};
  assert.equal(verdict(request(),()=>connection),undefined);
  const host=request();host.headers.host='attacker.example';assert.equal(verdict(host,()=>connection),403);
  const origin=request();origin.headers.origin='https://attacker.example';assert.equal(verdict(origin,()=>connection),403);
  const site=request();site.headers['sec-fetch-site']='cross-site';assert.equal(verdict(site,()=>connection),403);
  const cookie=request();cookie.headers.cookie='invalid';assert.equal(verdict(cookie,()=>connection),401);
});

test('a rejection getter is observed once and can never change refusal into acceptance',()=>{let count=0;assert.equal(verdict(request(),()=>({admit:()=>({get rejection(){return ++count===1?401:undefined}})})),401);assert.equal(count,1);});
