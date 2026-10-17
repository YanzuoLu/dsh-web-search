// Protocol and dialect detection ported from YanzuoLu/pi-web-search (MIT).
// Provider names only identify Pi's special transports, never a gateway allowlist.
export function providerKind(model) {
  if (model.provider === 'deepseek') return 'deepseek'
  if (model.provider === 'antigravity' || model.api === 'antigravity') return 'google'
  if (model.provider === 'google-generative-ai' || model.api === 'google-generative-ai') return 'google'
  if (model.provider === 'ollama-cloud' || URL.parse(model.baseUrl)?.hostname === 'ollama.com') return 'ollama'
  if (model.provider === 'xai' && model.api === 'openai-responses') return 'xai'
  if (['openai-responses', 'azure-openai-responses', 'openai-codex-responses'].includes(model.api)) return 'openai'
  if (model.api === 'anthropic-messages') return 'anthropic'
  return 'unsupported'
}

export function searchDialect(model) {
  const override = model.compat?.webSearchDialect
  if (override === 'grok' || override === 'openai') return override
  if (providerKind(model) === 'xai' || /^grok([.-]|$)/i.test(model.id)) return 'grok'
  return 'openai'
}

export function hasNativeSearch(model) {
  return ['anthropic', 'openai', 'xai'].includes(providerKind(model))
}
