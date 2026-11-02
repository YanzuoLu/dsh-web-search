// Citation rendering and source normalization adapted from pi-web-search (MIT).
function normalizeUrl(url) {
  const parsed = URL.parse(url)
  if (!parsed) return url
  parsed.hash = ''
  if (!/(^|\.)(youtube\.com|youtu\.be)$/i.test(parsed.hostname)) {
    for (const name of [...parsed.searchParams.keys()]) {
      if (['ref', 'referral_type', 'openLinerExtension', '_clear', 'lang', 'api-mode'].includes(name)
        || name.toLowerCase().startsWith('utm_')) parsed.searchParams.delete(name)
    }
  }
  return parsed.href
}

function titleFromUrl(url) {
  const parsed = URL.parse(url)
  return parsed?.pathname.split('/').filter(Boolean).pop() || parsed?.hostname || url
}

function isJunk(url) {
  const parsed = URL.parse(url)
  if (!parsed) return false
  let path
  try { path = decodeURIComponent(parsed.pathname).toLowerCase() } catch { return false }
  return /\.(gz|zip|tgz|tar|woff2?|ttf|otf|eot|webm|mp4|mp3|wav|eps|sql|csv|xlsx?|pptx?)$/.test(path) || path.endsWith('/%')
}

/** Source order and inserted reference numbers are computed together. */
export function renderResult(text, citations, results, dialect, truncated = false) {
  const sources = []
  const positions = new Map()
  const insertions = new Map()
  const sourceIndex = (item) => {
    if (!item?.url) return undefined
    const url = normalizeUrl(item.url)
    if (isJunk(url)) return undefined
    if (!positions.has(url)) {
      positions.set(url, sources.length + 1)
      sources.push({ url, title: item.title || titleFromUrl(url) })
    }
    return positions.get(url)
  }
  for (const citation of citations) {
    const index = sourceIndex(citation)
    if (index === undefined || dialect === 'grok') continue
    let end = citation.endIndex
    if (citation.citedText?.trim()) {
      const quote = citation.citedText.trim()
      const start = text.indexOf(quote)
      if (start >= 0) end = start + quote.length
    }
    if (end === undefined) continue
    end = Math.max(0, Math.min(end, text.length))
    insertions.set(`${end}:${index}`, { end, marker: `[${index}]` })
  }
  for (const source of results) sourceIndex(source)
  for (const { end, marker } of [...insertions.values()].sort((a, b) => b.end - a.end)) {
    text = text.slice(0, end) + marker + text.slice(end)
  }
  return { ...(text ? { content: text } : {}), sources, truncated }
}
