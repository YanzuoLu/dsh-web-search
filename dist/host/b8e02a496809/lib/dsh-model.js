import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import { WebError } from '@deepseek-ai/dsh-web'
import { hasNativeSearch } from './routing.js'

/** The provider-owned Antigravity transport, only for its exact native route. */
function antigravityTransport(adapter, model) {
  return model.provider === 'antigravity' && model.api === 'antigravity-api'
    && adapter.antigravityTransport?.version === 1
    ? adapter.antigravityTransport : undefined
}

/**
 * Freeze the calling agent's actual pi-ai model and transport configuration.
 *
 * dsh 0.2.2-rc.2 exposes neither model.api nor the authenticated Models collection
 * through LlmRuntime. Keep the read-only adapter bridge here. It uses the same
 * immutable snapshot, credential resolver and request-header preparation as chat,
 * including OAuth refresh, configured key references, header contributors,
 * endpoints and model overrides. Non-pi-ai routes return no native call, so
 * dispatch can select its fallback.
 *
 * `options.provider` and `options.model` pin one search route instead of the
 * caller's, and `options.reasoningEffort` pins the search effort. Without a
 * pinned effort, a search on the caller's route uses the caller's effort and a
 * search on a pinned route uses that route's profile default.
 */
export function resolveSearchCall(ctx, options = {}) {
  const session = ctx.get('agents')?.currentInitiator()?.session
  const caller = session?.requestContext()
  const pinned = options.provider !== undefined
  if (!caller && !pinned) return undefined
  const route = pinned ? { provider: options.provider, model: options.model } : caller
  const adapter = ctx.get('llm')?.adapters.get(route.provider)?.adapter
  if (!(adapter instanceof PiAiAdapter)) {
    if (route.provider === 'antigravity') {
      throw new WebError('Antigravity search requires the native PiAiAdapter transport v1', 'WEB_PROVIDER_ERROR')
    }
    return undefined
  }

  const snapshot = adapter.current()
  const profile = adapter.profileOf(snapshot, route.provider)
  const model = adapter.modelOf(snapshot, route.provider, route.model)
  const reasoning = options.reasoningEffort
    ?? (pinned ? undefined : session.requestHeader()?.config.reasoningEffort)
    ?? profile.reasoning
  const antigravity = antigravityTransport(adapter, model)

  return {
    model,
    reasoning,
    ...(antigravity ? { antigravity } : {}),
    async stream(context, options) {
      const apiKey = await adapter.config.resolveApiKey(route.provider, profile)
      options.signal?.throwIfAborted()
      const request = Object.freeze({ provider: route.provider, model: route.model, baseURL: model.baseUrl })
      const initial = new Headers(profile.headers)
      const headers = adapter.config.prepareHeaders?.(request, initial) ?? initial
      for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)
      return snapshot.models.streamSimple(model, context, {
        ...(apiKey === undefined ? {} : { apiKey }),
        thinkingBudgets: profile.thinkingBudgets,
        cacheRetention: profile.cacheRetention,
        timeoutMs: profile.timeoutMs,
        headers: Object.fromEntries(headers),
        maxRetries: 0,
        ...options,
      })
    },
  }
}

/**
 * Whether the pi-ai route `provider` has supported native search, for `model`
 * when given. Tool readiness names only the route, so any model qualifies it.
 */
export function routeHasNativeSearch(ctx, provider, model) {
  const adapter = ctx.get('llm')?.adapters.get(provider)?.adapter
  if (!(adapter instanceof PiAiAdapter)) return false
  return adapter.current().models.getModels(provider).some(entry => (model === undefined || entry.id === model)
    && hasNativeSearch(entry, antigravityTransport(adapter, entry)))
}
