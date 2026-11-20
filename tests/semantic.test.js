import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

test('semantic worker integration with deterministic embeddings and real sqlite-vec', async () => {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT
  const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('./semantic-preload.js',import.meta.url)),
    '--test', fileURLToPath(new URL('./semantic-cases.js',import.meta.url))], { stdio:['ignore','pipe','pipe'], env })
  let output=''
  child.stdout.on('data',data=>{output+=data})
  child.stderr.on('data',data=>{output+=data})
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
  assert.equal(code,0,output)
})
