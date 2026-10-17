# dsh-web-search

Model-native OpenAI and Anthropic search backends for DeepSeek Harness (dsh).

The plugin changes only the backend behind dsh's existing `web_search`. Its name, `queries` parameter, description, permissions, timeouts, multi-query execution and presentation stay unchanged. `web_fetch` is untouched. Other routes still call the original search backend with the original request and cancellation signal. No search or fetch provider setting is rewritten.

## Routing

The calling agent's configured model selects the backend on each search, including searches made by subagents. Provider names are not an allowlist. For example, an `nv-inference` or another renamed gateway model with `api: anthropic-messages` uses Anthropic search.

| Model API | Backend |
|---|---|
| `anthropic-messages` | Messages `web_search_20250305` |
| `openai-responses` | Responses `web_search` |
| `azure-openai-responses` | Azure Responses `web_search` |
| `openai-codex-responses` | Codex Responses `web_search` |
| Other protocols | Original dsh search backend |

Detection follows the installed [YanzuoLu/pi-web-search](https://github.com/YanzuoLu/pi-web-search) fork. Its special DeepSeek, Google and Ollama routes retain dsh's existing backend. Native xAI and gateway Grok models use the Responses backend with the Grok dialect. As in Pi, an explicit `model.compat.webSearchDialect` takes precedence over model-id detection when the configured model carries it.

A compatible message protocol does **not** guarantee server-side search support. A supported route whose server rejects the search tool reports that error rather than silently sending the query to another provider. Chat Completions is not treated as Responses.

## Transport and authentication

Search uses the same pi-ai `Models` collection, resolved model descriptor and credential resolver as the active dsh route. Configured endpoints, model overrides, headers, API-key references and OAuth refresh remain owned by dsh. The plugin does not read or keep a separate token file. Request-shaping plugins such as `dsh-anthropic-auth` remain in the fetch path.

The model and reasoning effort follow the calling agent. Requests use SSE so citations and source URLs can be recovered from the raw provider response. The ordinary pi-ai parser simultaneously consumes the response. Search results are projected into dsh's existing `content`, `sources` and `truncated` result shape.

There is one version-specific adapter bridge in `lib/dsh-model.js`. dsh 0.2.0-rc.2 does not publicly expose `model.api` or its authenticated Models collection. This bridge reads the adapter's immutable snapshot and calls its existing credential resolver. It neither modifies the adapter nor copies its authentication implementation. The dsh peer versions are exact because this bridge must be checked against future releases.

## Install

```sh
dsh plugin --profile web add github:YanzuoLu/dsh-web-search
```

Restart dsh after installing. There are no plugin settings. The existing dsh search-tool deadline still applies to the auxiliary model request.

This plugin does not add Pi's `urls` argument, `url_context`, or model-assisted `web_fetch`.

## Credit

The protocol detection, search-tool request shapes, SSE handling and citation processing are adapted from [pi-web-search](https://github.com/ttttmr/pi-web-search) by ttttmr and the [YanzuoLu fork](https://github.com/YanzuoLu/pi-web-search) at `2493ea0`, under the MIT license. The dsh integration uses its own model and authentication runtime, rather than Pi extension APIs.
