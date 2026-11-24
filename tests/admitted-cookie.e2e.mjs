import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {request as httpRequest} from 'node:http';
import {Readable} from 'node:stream';
import {EventEmitter} from 'node:events';
const core=process.env.DSH_CORE_ROOT;
const tc=process.env.TC_ROOT;
const fts=process.env.FTS_ROOT;
assert(core&&tc&&fts,'DSH_CORE_ROOT, TC_ROOT, FTS_ROOT required');
const req=createRequire(core+'/packages/client/connection/package.json');
const {Context}=await import(req.resolve('@deepseek-ai/cordis'));
const Connection=await import(pathToFileURL(core+'/packages/client/connection/lib/index.js'));
const Token=await import(pathToFileURL(core+'/packages/host/authentication-token/lib/index.js'));
const {WebServer}=await import(pathToFileURL(core+'/packages/host/webserver/lib/index.js'));
const Cron=await import(pathToFileURL(tc+'/modules/cron/index.js'));
const Fts=await import(pathToFileURL(fts+'/index.js'));
const ctx=new Context(),root=mkdtempSync(join(tmpdir(),'dsh-real-cookie-'));
let record;
ctx.provide('credentials',{async readRecord(){return record},async modifyRecord(key,mutate){record=await mutate(record);return record},async deleteRecord(){record=undefined}});
ctx.provide('sessions',{get(){}});ctx.provide('sessionQuery',{async listSessions(){return[]}});ctx.provide('tools',{register(){return()=>{}}});
const results=[];
try{
 const server=ctx.plugin(WebServer,{host:'127.0.0.1',port:0});await server.await();
 const conn=ctx.plugin(Connection,{trustedHosts:[]});await conn.await();
 const token=ctx.plugin(Token,{cookieMaxAgeDays:1});await token.await();
 const base='http://127.0.0.1:'+ctx.webServer.port;
 const entries=[];ctx.emit('webserver/entry-url',base,entries);assert(entries.length);
 const login=await fetch(entries[0].url,{redirect:'manual'});assert([302,303].includes(login.status));
 const cookie=login.headers.get('set-cookie')?.split(';',1)[0];assert(cookie?.startsWith('dsh-auth-'));
 // Real browser cookie is exchanged by the actual token provider. Never log it.
 const cronFiber=ctx.plugin({inject:['webServer','connection'],apply(c){Cron.apply(c,{dir:join(root,'cron'),pollMs:600000})}});await cronFiber.await();
 const ftsFiber=ctx.plugin(Fts,{path:join(root,'fts.sqlite'),startupDelayMs:600000,refreshIntervalMs:0,semantic:{enabled:false}});await ftsFiber.await();
 await new Promise(setImmediate);
 // A strict consumer has only connection, never its nested authentication service.
 let strictPeerResult;
 const strict=ctx.plugin({inject:['connection'],apply(c){
  try{c.connection.admit({headers:{host:new URL(base).host,cookie}});strictPeerResult='unexpected-success'}
  catch(error){strictPeerResult=String(error.message)}
 }});await strict.await();assert.match(strictPeerResult,/connection.authentication.*without inject/);
 async function request(path,{method='GET',origin=base,auth=cookie,body,host}={}){
  const headers={cookie:auth};if(origin!==null)headers.origin=origin;if(host)headers.host=host;
  if(body)headers['content-type']='application/json';
  const response=await new Promise((resolve,reject)=>{
   const req=httpRequest(base+path,{method,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,text:Buffer.concat(chunks).toString()}));});
   req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
  });
  const text=response.text;let payload;try{payload=JSON.parse(text)}catch{}
  results.push({path,method,origin:origin===null?'absent':'same-origin-or-test',host:host??new URL(base).host,credential:auth===cookie?'valid':'invalid',status:response.status,json:!!payload});
  return {status:response.status,payload,text};
 }
 const routes=[['/plugins/dsh-cron/state',{}],['/plugins/dsh-cron/action',{method:'POST',body:{action:'validate',job:{id:'fixture',enabled:false,cron:'* * * * *',timeZone:'UTC',command:['true'],timeoutSeconds:1,catchUp:false}}}],['/session-fts/api/status',{}],['/session-fts/api/search',{method:'POST',body:{query:'DEPLOYMENT_OK',scope:'all',days:0,limit:5}}]];
 const expectOld=process.env.EXPECT_OLD==='1';
 for(const [path,options] of routes){
  for(const origin of [null,base]){const r=await request(path,{...options,origin});assert.equal(r.status,expectOld?403:200,JSON.stringify({path,body:r.text}));}
  assert.equal((await request(path,{...options,auth:'dsh-auth-invalid=invalid'})).status,401);
  assert.equal((await request(path,{...options,origin:'https://attacker.invalid'})).status,403);
  assert.equal((await request(path,{...options,origin:null,host:'attacker.invalid'})).status,403);
 }
 const peerControls=[];
 if(!expectOld){
  const guest=ctx.connection.createPeer({principal:{kind:'test-guest'}});
  const stopped=ctx.connection.createPeer({principal:{kind:'owner'}});await stopped.dispose();
  for(const [path,options] of routes){
   const route=ctx.webServer.responderFor(path);
   for(const [label,peer] of [['missing',undefined],['non-owner',guest],['aborted',stopped]]){
    const req=Object.assign(Readable.from(options.body?[Buffer.from(JSON.stringify(options.body))]:[]),{headers:{host:new URL(base).host,origin:base,'content-type':'application/json'},method:options.method??'GET',url:path});
    const res=new EventEmitter();let status;
    res.writeHead=value=>{status=value};res.end=()=>{res.writableEnded=true};
    await route.handler(req,res,peer);assert.equal(status,403);peerControls.push({path,peer:label,status});
   }
  }
  await guest.dispose();
 }
 console.log(JSON.stringify({expectedOld:expectOld,actualTokenProvider:true,actualWebServer:true,strictConsumerFailure:strictPeerResult,results,peerControls,tempRoot:root}));
}finally{await ctx.fiber.dispose()}
