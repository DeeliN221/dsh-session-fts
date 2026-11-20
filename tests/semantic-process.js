// A genuine OS process owns each SemanticSearch and its worker.
import { SemanticSearch } from '../host/semantic.js'
const semantic = new SemanticSearch(JSON.parse(process.env.SEMANTIC_PROCESS_CONFIG))
let prior
const statusTimer = setInterval(() => {
  const current = JSON.stringify(semantic.status)
  if (current !== prior) { prior = current; process.send?.({ status: semantic.status }) }
}, 10)
process.on('message', async ({ id, type, query }) => {
  try {
    const result = type === 'search' ? await semantic.search(query)
      : type === 'refresh' ? await semantic.refresh() : await semantic.close()
    process.send?.({ id, result })
    if (type === 'close') { clearInterval(statusTimer); process.disconnect() }
  } catch (error) { process.send?.({ id, error: error.message }) }
})
process.on('disconnect', () => { clearInterval(statusTimer); void semantic.close() })
