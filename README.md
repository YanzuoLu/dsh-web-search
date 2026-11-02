# dsh-web-search

Model-native OpenAI, Anthropic and Antigravity Google Search Grounding backends for DeepSeek Harness (dsh).

The plugin changes only the backend behind dsh's existing `web_search`. Its name, `queries` parameter, description, permissions, timeouts, multi-query execution and presentation stay unchanged. `web_fetch` is untouched. Other routes still call the original search backend with the original request and cancellation signal. No search or fetch provider setting is rewritten.

## Routing

The calling agent's configured model selects the backend on each search, including searches made by subagents. Provider names are not an allowlist. For example, an `nv-inference` or another renamed gateway model with `api: anthropic-messages` uses Anthropic search.

| Model API | Backend |
|---|---|
| `anthropic-messages` | Messages `web_search_20250305` |
| `openai-responses` | Responses `web_search` |
| `azure-openai-responses` | Azure Responses `web_search` |
| `openai-codex-responses` | Codex Responses `web_search` |
| `antigravity-api`, provider `antigravity`, transport v1 | Gemini Google Search Grounding |
| Other protocols | Original dsh search backend |

Detection follows the installed [YanzuoLu/pi-web-search](https://github.com/YanzuoLu/pi-web-search) fork. Its special DeepSeek, ordinary Google and Ollama routes retain dsh's existing backend. Antigravity is a distinct route and requires the native provider-owned transport described below. Missing or incompatible Antigravity transport reports an error instead of silently forwarding the query to a different provider. Native xAI and gateway Grok models use the Responses backend with the Grok dialect. As in Pi, an explicit `model.compat.webSearchDialect` takes precedence over model-id detection when the configured model carries it.

A compatible message protocol does **not** guarantee server-side search support. A supported route whose server rejects the search tool reports that error rather than silently sending the query to another provider. Chat Completions is not treated as Responses.

## Transport and authentication

OpenAI and Anthropic search use the same pi-ai `Models` collection, resolved model descriptor and credential resolver as the active dsh route. Configured endpoints, model overrides, headers, API-key references and OAuth refresh remain owned by dsh. The plugin does not read or keep a separate token file. Request-shaping plugins such as `dsh-anthropic-auth` remain in the fetch path.

By default the route and reasoning effort follow the calling agent; see [Configuration](#configuration) to pin them. OpenAI and Anthropic requests use SSE so citations and source URLs can be recovered from the raw provider response. The ordinary pi-ai parser simultaneously consumes the response. Search results are projected into dsh's existing `content`, `sources` and `truncated` result shape.

There is one version-specific adapter bridge in `lib/dsh-model.js`. dsh 0.2.0-rc.2 does not publicly expose `model.api` or its authenticated Models collection. This bridge reads the adapter's immutable snapshot and calls its existing credential resolver for OpenAI and Anthropic. Antigravity instead receives the provider's public transport without resolving credentials here. It neither modifies the adapter nor copies its authentication implementation. The dsh peer versions are exact because this bridge must be checked against future releases.

### Antigravity integration

The separate Antigravity provider must extend the exported native `PiAiAdapter`, register provider `antigravity` with model API `antigravity-api`, and expose its own read-only `antigravityTransport = Object.freeze({ version: 1, request(operation, body, { signal }) })`. `request` returns a `Response`. This plugin calls only `generateContent`. The provider owns native DSH authentication, refresh, project injection and headers. Search never resolves credentials or reads tokens/auth files on this route. No provider, model tool, slash command, account switcher or image generation is registered here.

Grounding uses an independent Gemini candidate, not the chat model, even when chatting with Claude. The ordered candidates are `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite` and `gemini-3-flash`. Only HTTP 404 or an explicit unsupported/unknown model HTTP 400 advances to the next candidate. Authentication, quota, other HTTP errors, malformed success bodies and network failures surface immediately. No extra deadline is added. The existing outer tool deadline and cancellation signal cover requests and response-body reads.

Visible candidate parts and Google `groundingMetadata` are projected into the usual result. HTTP(S) source URLs, including Google's opaque grounding redirects, are kept and normalized/deduplicated by the existing result renderer. No source page, redirect, title or relay is fetched. UTF-8 citation offsets are verified within their original content part, including Chinese and emoji. A mismatched span is relocated only when its quoted text occurs exactly once in that part. Ambiguous or unverifiable spans are omitted rather than fabricated. A valid grounded source list may therefore have no inline markers. Missing candidates, empty visible text or no usable grounding sources are provider errors, never ungrounded search success.

## Install

```sh
dsh plugin --profile web add github:YanzuoLu/dsh-web-search
```

A new installation mounts in a live profile without restarting DSH. Host releases use content-addressed snapshots so Node does not reuse an older cached module graph. After updating an already loaded version, disable and re-enable only this bundle in Plugin Manager to activate the new snapshot. The existing dsh search-tool deadline still applies to the auxiliary model request.

Build the committed snapshot with `node scripts/build.mjs`. The stable entry id remains `web-search`, so existing profile configuration keeps applying.

## Configuration

Every field is optional. Without configuration, each search selects the calling agent's route and reasoning effort. Antigravity always uses its independent Gemini grounding candidate and an empty `generationConfig`, so the chat model and `reasoningEffort` do not alter its grounding payload.

| Field | Meaning |
|---|---|
| `reasoningEffort` | Reasoning effort for every search request, clamped to what the model supports. `off` disables reasoning. |
| `provider`, `model` | A fixed search route, set together. It must be a pi-ai route; a route without native search falls back to the original dsh backend, except that a misconfigured Antigravity route errors instead of crossing providers. |

Without `reasoningEffort`, a search on the caller's route uses the caller's effort, and a search on a fixed route uses that route's default effort.

A search turn rarely needs deep reasoning. At high efforts it can run past dsh's search-tool deadline (the host's configured outer tool budget), so pinning a lower effort keeps searches fast:

```yaml
- id: web-search
  config:
    reasoningEffort: medium
```

This plugin does not add Pi's `urls` argument, `url_context`, or model-assisted `web_fetch`.

## Credit

The protocol detection, search-tool request shapes, SSE handling and citation processing are adapted from [pi-web-search](https://github.com/ttttmr/pi-web-search) by ttttmr and the [YanzuoLu fork](https://github.com/YanzuoLu/pi-web-search) at `2493ea0`, under the MIT license. The dsh integration uses its own model and authentication runtime, rather than Pi extension APIs.

The Antigravity grounding request shape, Gemini candidate list and part-relative UTF-8 verification are adapted from [Rahularya01/pi-antigravity at `3870729`](https://github.com/Rahularya01/pi-antigravity/blob/3870729/src/search/search.ts), under the MIT license. Its standalone tools, commands, authentication, account handling and source-enrichment network code are not included.
