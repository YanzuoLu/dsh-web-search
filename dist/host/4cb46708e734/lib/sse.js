// SSE framing adapted from pi-web-search (MIT).
export async function readSse(response, signal, accept) {
  if (!response.body) throw new Error('Search response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data = []
  let ended = false
  const flush = () => {
    const raw = data.join('\n').trim()
    data = []
    if (!raw || raw === '[DONE]') return false
    return accept(JSON.parse(raw)) === true
  }
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) {
        ended = true
        buffer += decoder.decode()
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trim())
        flush()
        return
      }
      buffer += decoder.decode(chunk.value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (line === '') {
          if (flush()) return
        } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
    }
  } finally {
    if (!ended) await reader.cancel()
    reader.releaseLock()
  }
}
