import { WebError } from '@deepseek-ai/dsh-web'
import { readSse } from './sse.js'
import { renderResult } from './results.js'

/** Read sources the ordinary pi-ai assistant-message projection does not retain. */
export async function collectSearch(response, signal, dialect) {
  let text = ''
  let truncated = false
  const citations = []
  const sources = []
  const collectAnnotation = (item) => {
    if (item?.type !== 'url_citation') return
    const nested = item.url_citation ?? item.urlCitation
    citations.push({
      url: item.url ?? nested?.url,
      title: item.title ?? nested?.title,
      endIndex: item.end_index ?? item.endIndex ?? nested?.end_index ?? nested?.endIndex,
    })
  }
  const collectItem = (item) => {
    if (item?.type === 'web_search_call') {
      const action = item.action ?? {}
      for (const source of action.sources ?? []) {
        sources.push({ url: source.url, title: source.title || source.display_name || source.name })
      }
      if (action.url) sources.push({ url: action.url })
    }
    if (item?.type === 'message') {
      for (const content of item.content ?? []) {
        for (const annotation of content.annotations ?? []) collectAnnotation(annotation)
      }
    }
  }
  await readSse(response, signal, (event) => {
    if (event.type === 'error' || event.type === 'response.failed') {
      throw new WebError(event.message || event.error?.message || event.response?.error?.message || 'Search response failed', 'WEB_PROVIDER_ERROR')
    }
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block?.type === 'text') {
        text += block.text || ''
        for (const citation of block.citations ?? []) {
          citations.push({ url: citation.url, title: citation.title, citedText: citation.cited_text })
        }
      }
      if (block?.type === 'web_search_tool_result') {
        if (Array.isArray(block.content)) sources.push(...block.content)
        else if (block.content?.type === 'web_search_tool_result_error') {
          throw new WebError(`Web search failed: ${block.content.error_code}`, 'WEB_PROVIDER_ERROR')
        }
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') text += event.delta.text || ''
      if (event.delta?.type === 'citations_delta') {
        const citation = event.delta.citation
        if (citation?.type === 'web_search_result_location') {
          citations.push({ url: citation.url, title: citation.title, citedText: citation.cited_text })
        }
      }
    } else if (event.type === 'message_delta') {
      truncated ||= event.delta?.stop_reason === 'max_tokens'
    } else if (event.type === 'message_stop') return true
    else if (event.type === 'response.output_text.delta') text += event.delta || ''
    else if (event.type === 'response.output_text.annotation.added') collectAnnotation(event.annotation)
    else if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') collectItem(event.item)
    else if (['response.completed', 'response.done', 'response.incomplete'].includes(event.type)) {
      const output = event.response?.output ?? []
      output.forEach(collectItem)
      if (!text) text = output.flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('\n')
      truncated ||= event.type === 'response.incomplete' || event.response?.status === 'incomplete'
      return true
    }
  })
  return renderResult(text, citations, sources, dialect, truncated)
}
