// Test-process module substitution keeps the production worker API unchanged.
import { registerHooks } from 'node:module'
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@huggingface/transformers') return { url: new URL('./semantic-embeddings.js', import.meta.url).href, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
