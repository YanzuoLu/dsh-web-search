import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

/**
 * Freeze the calling agent's actual pi-ai model and transport configuration.
 *
 * dsh 0.2.0-rc.2 exposes neither model.api nor the authenticated Models collection
 * through LlmRuntime. Keep the read-only adapter bridge here. It uses the same
 * immutable snapshot and credential resolver as chat, including OAuth refresh,
 * configured key references, custom headers, endpoints and model overrides.
 * Non-pi-ai routes keep the original search backend.
 */
export function resolveSearchCall(ctx) {
  const session = ctx.get('agents')?.currentInitiator()?.session
  const route = session?.requestContext()
  if (!route) return undefined
  const adapter = ctx.get('llm')?.adapters.get(route.provider)?.adapter
  if (!(adapter instanceof PiAiAdapter)) return undefined

  const snapshot = adapter.current()
  const profile = adapter.profileOf(snapshot, route.provider)
  const model = adapter.modelOf(snapshot, route.provider, route.model)
  const reasoning = session.requestHeader()?.config.reasoningEffort ?? profile.reasoning
  const headers = new Headers(profile.headers)
  for (const [name, value] of Object.entries(attributionHeaders())) headers.set(name, value)

  return {
    model,
    reasoning,
    async stream(context, options) {
      const apiKey = await adapter.config.resolveApiKey(route.provider, profile)
      options.signal?.throwIfAborted()
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
