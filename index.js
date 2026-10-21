import { symbols } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveSearchCall } from './lib/dsh-model.js'
import { hasNativeSearch } from './lib/routing.js'
import { searchNative } from './lib/search.js'

export const name = 'web-search'
export const inject = ['web', 'llm']
export const Config = z.object({
  provider: z.string().description('Provider of a fixed search model. Set together with model; unset searches on the calling agent\'s route.'),
  model: z.string().description('Model id of a fixed search model. Set together with provider.'),
  reasoningEffort: z.string().description('Reasoning effort for every search request; "off" disables reasoning. Unset follows the calling agent on its own route, or the fixed model\'s default.'),
})

const installations = new WeakMap()

/** Interpose only on search dispatch; tool definitions and fetch stay untouched. */
export function apply(ctx, config = {}) {
  if ((config.provider === undefined) !== (config.model === undefined)) {
    throw new Error('web-search: set provider and model together')
  }
  const web = ctx.web[symbols.original] ?? ctx.web
  ctx.effect(() => {
    let installation = installations.get(web)
    if (!installation) {
      installation = installSearchBackend(web, callCtx => resolveSearchCall(callCtx, config))
      installations.set(web, installation)
    }
    installation.users += 1
    return () => {
      installation.users -= 1
      if (installation.users !== 0) return
      installation.dispose()
      installations.delete(web)
    }
  }, 'web-search backend')
}

/** Preserve the caller's Cordis context and the original provider selection. */
export function installSearchBackend(web, resolveCall = resolveSearchCall, search = searchNative) {
  const own = Object.getOwnPropertyDescriptor(web, 'search')
  const original = web.search
  let active = true
  async function wrapper(request, signal) {
    const call = active ? resolveCall(this.ctx) : undefined
    if (!call || !hasNativeSearch(call.model)) return original.call(this, request, signal)
    const result = await search(call, request.query, signal)
    if (request.maxResults === undefined || result.sources.length <= request.maxResults) return result
    return { ...result, sources: result.sources.slice(0, request.maxResults), truncated: true }
  }
  web.search = wrapper
  return {
    users: 0,
    dispose() {
      active = false
      if (web.search !== wrapper) return
      if (own) Object.defineProperty(web, 'search', own)
      else delete web.search
    },
  }
}
