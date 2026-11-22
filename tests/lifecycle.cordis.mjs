import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {realpathSync,mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import * as plugin from '../index.js';
// Use the target Host's actual Cordis instance; fail if it is unavailable.
const runtime=process.env.DSH_TEST_RUNTIME;
if(!runtime)throw new Error('Set DSH_TEST_RUNTIME to the target DSH node_modules directory');
const req=createRequire(realpathSync(join(runtime,'@deepseek-ai/dsh-session/package.json')));
const {Context}=await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')));
test('actual Cordis loads and disposes the exported async entry without swallowing its return',async()=>{
 const root=mkdtempSync(join(tmpdir(),'fts-lifecycle-'));const ctx=new Context();let tool,route;
 ctx.provide('sessions',{get(){}});ctx.provide('sessionQuery',{async listSessions(){return[]}});
 ctx.provide('tools',{register(value){tool=value;return()=>{tool=undefined}}});
 ctx.provide('webServer',{register(value){route=value;return()=>{route=undefined}}});
 ctx.provide('connection',{requestRejection(){}});
 try{
  await new Promise(setImmediate);
  const fiber=await ctx.plugin(plugin,{path:join(root,'fts.sqlite'),startupDelayMs:600000,refreshIntervalMs:0,semantic:{enabled:false}});
  await new Promise(setImmediate);await fiber.await();
  assert.equal(fiber.state,2);const service=ctx.get('sessionRetrieval');assert(service);assert(tool);assert(route);
  assert.match(await tool.execute({query:'absent',scope:'all',days:0},{}),/0 session/);
  await fiber.dispose();assert.equal(ctx.get('sessionRetrieval'),undefined);assert.equal(tool,undefined);assert.equal(route,undefined);
  const reopened=await ctx.plugin(plugin,{path:join(root,'fts.sqlite'),startupDelayMs:600000,refreshIntervalMs:0,semantic:{enabled:false}});
  await new Promise(setImmediate);await reopened.await();assert.equal(reopened.state,2);assert.notEqual(ctx.get('sessionRetrieval'),service);await reopened.dispose();
 }finally{await ctx.fiber.dispose()}
});
