import { randomUUID } from 'node:crypto'
import { WebError } from '@deepseek-ai/dsh-web'
import { hasNativeSearch } from './routing.js'
import { renderResult } from './results.js'

// Request shape, search candidates and UTF-8 part-offset verification adapted from
// Rahularya01/pi-antigravity src/search/search.ts at 3870729 (MIT).
// Copyright (c) 2026 Rahul Arya
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
//
// Authentication, account selection and source enrichment are deliberately absent.
const searchModels = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash']
const instruction = 'Use Google Search grounding to return a compact evidence brief. Prefer primary sources, cite supported claims, and clearly identify gaps rather than inventing facts.'
const failure = message => new WebError(`Antigravity Google Search failed: ${message}`, 'WEB_PROVIDER_ERROR')

/** Consume the body under the existing tool signal, including a stalled read. */
async function readBody(response, signal) {
  signal?.throwIfAborted()
  if (!response.body) throw failure('response has no body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  let text = ''
  let bytes = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      signal?.throwIfAborted()
      if (chunk.done) return text + decoder.decode()
      bytes += chunk.value.byteLength
      if (bytes > 16 * 1024 * 1024) {
        await reader.cancel()
        throw failure('search response exceeds the 16 MiB limit')
      }
      text += decoder.decode(chunk.value, { stream: true })
    }
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

/** A verified UTF-8 part-relative span, never a guessed JS character offset. */
function citationEnd(part, segment) {
  const bytes = Buffer.from(part, 'utf8')
  let { startIndex: start = 0, endIndex: end } = segment
  const boundaries = new Map([[0, 0]])
  let byte = 0
  let char = 0
  for (const point of part) {
    byte += Buffer.byteLength(point, 'utf8')
    char += point.length
    boundaries.set(byte, char)
  }
  const quote = typeof segment.text === 'string' ? segment.text : undefined
  const valid = Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start
    && boundaries.has(start) && boundaries.has(end)
    && (quote === undefined || bytes.subarray(start, end).toString('utf8') === quote)
  if (!valid) {
    // Relocate only an unambiguous quote in this same part. Repeated claims and
    // malformed/mid-codepoint offsets must not acquire fabricated provenance.
    if (!quote) return undefined
    const found = part.indexOf(quote)
    if (found < 0 || part.indexOf(quote, found + 1) >= 0) return undefined
    start = Buffer.byteLength(part.slice(0, found), 'utf8')
    end = start + Buffer.byteLength(quote, 'utf8')
  }
  return boundaries.get(end)
}

/** Project Google grounding into the existing native result shape without fetching sources. */
export function parseAntigravitySearch(data) {
  const response = data?.response ?? data
  if (data?.error || response?.error) throw failure(data?.error?.message || response?.error?.message || 'provider returned an error')
  const candidate = response?.candidates?.[0]
  if (!candidate) throw failure('no candidate returned')
  const parts = []
  let text = ''
  for (const [index, part] of (candidate.content?.parts ?? []).entries()) {
    if (part.thought || typeof part.text !== 'string' || !part.text) continue
    if (parts.length) text += '\n\n'
    parts.push({ index, text: part.text, offset: text.length })
    text += part.text
  }
  if (!text.trim()) throw failure('no visible search answer returned')
  const grounding = candidate.groundingMetadata
  const chunks = new Map()
  for (const [index, chunk] of (grounding?.groundingChunks ?? []).entries()) {
    const web = chunk?.web
    if (typeof web?.uri !== 'string') continue
    const url = URL.parse(web.uri)
    if (!url || !['http:', 'https:'].includes(url.protocol)) continue
    chunks.set(index, { url: web.uri, title: typeof web.title === 'string' ? web.title.trim() : undefined })
  }
  if (!chunks.size) throw failure('no usable Google Search grounding sources returned')
  const citations = []
  for (const support of grounding.groundingSupports ?? []) {
    const segment = support?.segment
    if (!segment || !Array.isArray(support.groundingChunkIndices)) continue
    const part = parts.find(part => part.index === (segment.partIndex ?? 0))
    if (!part) continue
    const end = citationEnd(part.text, segment)
    if (end === undefined) continue
    for (const index of support.groundingChunkIndices) {
      const source = chunks.get(index)
      if (source) citations.push({ ...source, endIndex: part.offset + end })
    }
  }
  const result = renderResult(text, citations, [...chunks.values()], 'openai', candidate.finishReason === 'MAX_TOKENS')
  if (!result.sources.length) throw failure('no usable Google Search grounding sources returned')
  return result
}

/** Use only the provider-owned authenticated transport and narrowly bounded model fallback. */
export async function searchAntigravity(call, query, signal) {
  if (!hasNativeSearch(call.model, call.antigravity)) throw failure('native Antigravity transport v1 is unavailable')
  try {
    for (const [index, model] of searchModels.entries()) {
      signal?.throwIfAborted()
      const payload = {
        model,
        request: {
          systemInstruction: { role: 'user', parts: [{ text: instruction }] },
          contents: [{ role: 'user', parts: [{ text: query }] }],
          tools: [{ googleSearch: {} }],
          generationConfig: {},
        },
        requestType: 'agent',
        userAgent: 'antigravity',
        requestId: randomUUID(),
      }
      const response = await call.antigravity.request('generateContent', payload, { signal })
      const raw = await readBody(response, signal)
      let data
      try { data = JSON.parse(raw) } catch (error) {
        if (response.ok) throw failure('invalid JSON response')
        if (!(error instanceof SyntaxError)) throw error
      }
      signal?.throwIfAborted()
      if (!response.ok) {
        const message = data?.error?.message || data?.response?.error?.message || raw || response.statusText
        const unsupportedModel = response.status === 400
          && /\b(?:unsupported|unknown)\s+model\b(?!\s+(?:parameter|field|option)s?\b)|\bmodel(?:\s+['"`]?gemini[-\w./:]+['"`]?)?\s+(?:(?:is|was)\s+)?(?:not supported|unsupported|not found|does not exist)\b/i.test(message)
        if (index < searchModels.length - 1 && (response.status === 404 || unsupportedModel)) continue
        throw failure(`HTTP ${response.status}: ${message}`)
      }
      return parseAntigravitySearch(data)
    }
  } catch (error) {
    if (signal?.aborted) throw new WebError('Web search aborted', 'WEB_ABORTED', { cause: error })
    if (error instanceof WebError) throw error
    throw new WebError('Antigravity Google Search request failed', 'WEB_PROVIDER_ERROR', { cause: error })
  }
}
