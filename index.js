import { symbols } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import { resolveSearchCall, routeHasNativeSearch } from './lib/dsh-model.js'
import { hasNativeSearch, providerKind } from './lib/routing.js'
import { searchNative } from './lib/search.js'

export const name = 'web-search'
export const inject = ['web', 'llm']
export const Config = z.object({
  provider: z.string().description('Provider of a fixed search model. Set together with model; unset searches on the calling agent\'s route.'),
  model: z.string().description('Model id of a fixed search model. Set together with provider.'),
  reasoningEffort: z.string().description('Reasoning effort for searches on the calling or fixed route; "off" disables reasoning. Unset follows the calling agent on its own route, or the fixed model\'s default.'),
  fallback: z.union([
    z.const(null),
    z.object({
      provider: z.string().required().description('Provider used only when the calling route has no supported native search.'),
      model: z.string().required().description('Model id of the fallback search route.'),
      reasoningEffort: z.string().description('Fallback search effort; "off" disables reasoning. Unset uses the fallback route\'s default.'),
    }),
  ]).default(null).description('Optional native search route for unsupported protocols, never a retry after a search error.'),
})

const installations = new WeakMap()

/** Interpose only on search dispatch and readiness; tool definitions and fetch stay untouched. */
export function apply(ctx, config = {}) {
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('web-search: set provider and model together')
  }
  const web = ctx.web[symbols.original] ?? ctx.web
  ctx.effect(() => {
    let installation = installations.get(web)
    if (!installation) {
      installation = { backend: installSearchBackend(web), configurations: new Map() }
      installations.set(web, installation)
    }
    const registration = Symbol()
    installation.configurations.set(registration, config)
    // Overlapping reloads share a wrapper; the latest live configuration owns routing.
    const update = () => {
      const current = [...installation.configurations.values()].at(-1)
      installation.backend.configure(
        callCtx => resolveSearchCall(callCtx, current),
        current.fallback ? callCtx => resolveSearchCall(callCtx, current.fallback) : undefined,
        // Searches this plugin serves authenticate through their model route, not the original backend.
        (callCtx, llmProvider) => Boolean(current.fallback)
          || routeHasNativeSearch(callCtx, current.provider ?? llmProvider, current.model),
      )
    }
    update()
    return () => {
      installation.configurations.delete(registration)
      if (installation.configurations.size !== 0) return update()
      installation.backend.dispose()
      installations.delete(web)
    }
  }, 'web-search backend')
}

/** Prefer native search; resolve an optional fallback only for unsupported protocols. */
export function installSearchBackend(web, resolveCall = resolveSearchCall, search = searchNative, resolveFallback, resolveReady) {
  const originals = { search: web.search, searchReady: web.searchReady }
  const own = Object.fromEntries(Object.keys(originals).map(name => [name, Object.getOwnPropertyDescriptor(web, name)]))
  let active = true
  async function wrapper(request, signal) {
    if (!active) return originals.search.call(this, request, signal)
    let call = resolveCall(this.ctx)
    if (call && providerKind(call.model) === 'antigravity' && !hasNativeSearch(call.model, call.antigravity)) {
      throw new WebError('Antigravity search requires provider antigravity, API antigravity-api and transport v1', 'WEB_PROVIDER_ERROR')
    }
    if (!call || !hasNativeSearch(call.model, call.antigravity)) {
      if (!resolveFallback) return originals.search.call(this, request, signal)
      call = resolveFallback(this.ctx)
      if (!call || !hasNativeSearch(call.model, call.antigravity)) {
        throw new WebError('The configured fallback search route has no supported native search transport', 'WEB_PROVIDER_ERROR')
      }
    }
    const result = await search(call, request.query, signal)
    if (request.maxResults === undefined || result.sources.length <= request.maxResults) return result
    return { ...result, sources: result.sources.slice(0, request.maxResults), truncated: true }
  }
  /** dsh-tool-web declares web_search only while the search seam reports the calling route ready. */
  async function searchReady(llmProvider) {
    if (active && resolveReady?.(this.ctx, llmProvider)) return true
    return originals.searchReady.call(this, llmProvider)
  }
  const wrappers = { search: wrapper, searchReady }
  Object.assign(web, wrappers)
  return {
    configure(primary = resolveSearchCall, fallback, ready) {
      resolveCall = primary
      resolveFallback = fallback
      resolveReady = ready
    },
    dispose() {
      active = false
      for (const [name, method] of Object.entries(wrappers)) {
        if (web[name] !== method) continue
        if (own[name]) Object.defineProperty(web, name, own[name])
        else delete web[name]
      }
    },
  }
}
