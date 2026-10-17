import { randomUUID } from 'node:crypto'
import { clampThinkingLevel } from '@earendil-works/pi-ai'
import { WebError } from '@deepseek-ai/dsh-web'
import { providerKind, searchDialect } from './routing.js'
import { collectSearch } from './collect.js'

/** Add the provider-side search tool, not a new dsh tool. */
export function searchPayload(payload, model, reasoning) {
  if (providerKind(model) === 'anthropic') {
    return { ...payload, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 10 }] }
  }
  const codex = model.api === 'openai-codex-responses'
  const grok = searchDialect(model) === 'grok'
  const shaped = {
    ...payload,
    tools: [{ type: 'web_search' }],
    include: ['web_search_call.action.sources', ...(!codex && !grok ? ['web_search_call.results'] : [])],
    store: false,
    stream: true,
  }
  // The upstream Responses search leaves output limits to the provider.
  delete shaped.max_output_tokens
  if (model.reasoning && reasoning && reasoning !== 'off' && providerKind(model) !== 'xai') {
    shaped.reasoning = { effort: model.thinkingLevelMap?.[reasoning] ?? reasoning }
  } else delete shaped.reasoning
  if (codex) {
    shaped.instructions = "Answer the user's request using web search when needed."
    shaped.text = { verbosity: 'low' }
    shaped.tool_choice = 'required'
    shaped.parallel_tool_calls = true
  }
  return shaped
}

/** One auxiliary model turn through dsh's existing authenticated pi-ai collection. */
export async function searchNative(call, query, signal) {
  const { model } = call
  const controller = new AbortController()
  const upstream = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const dialect = searchDialect(model)
  const level = call.reasoning && call.reasoning !== 'off' && model.reasoning
    ? clampThinkingLevel(model, call.reasoning)
    : undefined
  let captured
  try {
    const stream = await call.stream({
      messages: [{ role: 'user', content: [{ type: 'text', text: query }], timestamp: Date.now() }],
    }, {
      signal: upstream,
      sessionId: randomUUID(),
      transport: 'sse',
      maxTokens: Math.min(Math.max(1024, Math.floor(model.maxTokens / 3) || 4096), 8192),
      ...(level && level !== 'off' && providerKind(model) !== 'xai' ? { reasoning: level } : {}),
      onPayload: payload => searchPayload(payload, model, level),
      fetch: async (input, init) => {
        // Keep installed request-shaping extensions in the path, including OAuth auth.
        const response = await globalThis.fetch(input, init)
        if (!response.ok || !response.body) return response
        const [ours, sdk] = response.body.tee()
        // Observe both outcomes immediately, without an unhandled parallel rejection.
        captured = collectSearch(new Response(ours, response), upstream, dialect).then(
          result => ({ result }), error => ({ error }),
        )
        return new Response(sdk, response)
      },
    })
    const message = await stream.result()
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      throw new WebError(message.errorMessage || `Search ${message.stopReason}`, signal?.aborted ? 'WEB_ABORTED' : 'WEB_PROVIDER_ERROR')
    }
    if (!captured) throw new Error('The search transport did not provide an HTTP event stream')
    const parsed = await captured
    if (parsed.error) throw parsed.error
    return { ...parsed.result, truncated: parsed.result.truncated || message.stopReason === 'length' }
  } catch (error) {
    if (signal?.aborted && !(error instanceof WebError)) {
      throw new WebError('Web search aborted', 'WEB_ABORTED', { cause: error })
    }
    throw error
  } finally {
    controller.abort()
    if (captured) await captured
  }
}
