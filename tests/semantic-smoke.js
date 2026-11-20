// Opt-in real download/inference smoke: node tests/semantic-smoke.js
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import assert from 'node:assert/strict'
import { SemanticSearch } from '../host/semantic.js'

const dir = mkdtempSync(join(tmpdir(),'semantic-real-'))
const path = join(dir,'fts.sqlite')
const db = new DatabaseSync(path)
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT);
  CREATE TABLE events(id INTEGER PRIMARY KEY,session_id TEXT,seq INTEGER,role TEXT,time INTEGER,text TEXT);
  INSERT INTO sessions VALUES('apple','/smoke','Fruit',1,2,NULL),('network','/smoke','Network',1,2,NULL);
  INSERT INTO events VALUES(1,'apple',1,'user',2,'I enjoy eating fresh apples and other fruit.'),
    (2,'network',1,'user',2,'Configure the firewall and troubleshoot TCP connections.');`)
const search = new SemanticSearch({ path, semantic: { enabled:true,model:process.env.SEMANTIC_MODEL ?? 'Xenova/multilingual-e5-small',
  cacheDir: process.env.SEMANTIC_MODEL_CACHE ?? join(tmpdir(),'dsh-semantic-models'),batchSize:2,
  chunkChars:1000,queryCacheSize:8,minScore:0,maxCandidates:10 } })
const timeout = setTimeout(()=> { void search.close() },120_000)
try {
  await search.refresh()
  const result=await search.search({query:'我喜欢吃苹果',offset:0,limit:10})
  assert.equal(result.sessions[0]?.sessionId,'apple')
  console.log('Actual multilingual q8 CPU model smoke passed',JSON.stringify(search.status))
} finally {
  clearTimeout(timeout)
  await search.close()
  db.close()
  rmSync(dir,{recursive:true,force:true})
}
