import { mkdirSync } from 'node:fs'

let pipelinePromise = null
let pipelineKey = ''

async function localPipeline(config) {
  const model = config.model || 'Xenova/bge-small-zh-v1.5'
  const cacheDir = config.cacheDir
  if (cacheDir) mkdirSync(cacheDir, { recursive: true })
  const endpoint = config.endpoint || 'https://hf-mirror.com'
  const key = model + '|' + (cacheDir || '') + '|' + endpoint
  if (pipelinePromise && pipelineKey === key) return pipelinePromise
  pipelineKey = key
  pipelinePromise = (async () => {
    const transformers = await import('@huggingface/transformers')
    if (cacheDir) transformers.env.cacheDir = cacheDir
    transformers.env.remoteHost = endpoint
    return transformers.pipeline('feature-extraction', model, { dtype: 'q8' })
  })()
  return pipelinePromise
}

async function localEmbed(texts, config) {
  const extractor = await localPipeline(config)
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  return output.tolist()
}

async function remoteEmbed(texts, config) {
  const base = String(config.baseUrl || '').replace(/\/+$/, '')
  if (!base) throw new Error('embedding.baseUrl is required for the openai provider')
  const response = await fetch(base + '/embeddings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}),
    },
    body: JSON.stringify({ model: config.model || 'text-embedding-3-small', input: texts }),
    signal: AbortSignal.timeout(config.timeoutMs || 20000),
  })
  if (!response.ok) throw new Error('embedding HTTP ' + response.status)
  const payload = await response.json()
  const rows = Array.isArray(payload.data) ? payload.data : []
  return rows.sort((a, b) => a.index - b.index).map(row => row.embedding)
}

export async function embedTexts(texts, config = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map(text => String(text || ''))
  if (list.length === 0 || list.every(text => !text.trim())) return null
  const provider = config.provider || 'local'
  if (provider === 'none') return null
  try {
    if (provider === 'openai') return await remoteEmbed(list, config)
    return await localEmbed(list, config)
  } catch (error) {
    if (typeof config.onError === 'function') config.onError(error)
    return null
  }
}

export function resetEmbedder() {
  pipelinePromise = null
  pipelineKey = ''
}
