import { appendFileSync } from 'node:fs'
export const env = { backends: { onnx: {} } }
export async function pipeline(task, model, options) {
  if (task !== 'feature-extraction' || options.dtype !== 'q8' || options.device !== 'cpu' || env.backends.onnx.numThreads !== 1) throw new Error('Incorrect model settings')
  if (model === 'fail') throw new Error('Model unavailable')
  if (model === 'hang') await new Promise(() => {})
  return async texts => {
    if (process.env.SEMANTIC_EMBED_LOG) appendFileSync(process.env.SEMANTIC_EMBED_LOG, `${JSON.stringify(texts)}\n`)
    await new Promise(resolve => setTimeout(resolve, 5))
    return { tolist: () => texts.map(text => {
      const vector = /apple|苹果/.test(text) ? [1,0,0] : /banana|香蕉/.test(text) ? [0,1,0] : [0,0,1]
      return vector
    }) }
  }
}
