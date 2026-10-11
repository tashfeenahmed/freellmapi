# Parallel web search in OpenCode

Add free web search and page fetching to OpenCode while using FreeLLMAPI for
inference. [Parallel Search MCP](https://docs.parallel.ai/integrations/mcp/search-mcp)
provides `web_search` and `web_fetch` without a Parallel account or API key.
Anonymous search uses Fast mode and is intended for exploration and light use.

Install OpenCode (this example uses 1.19.0) and configure your running FreeLLMAPI
gateway with its unified key:

```bash
npm install --global opencode-ai@1.19.0
export FREELLMAPI_API_KEY='<your FreeLLMAPI unified key>'
npx freellmapi setup-opencode --url http://localhost:3001
```

From your project directory, load the example as an additional configuration.
Replace the path with the absolute location of this checkout:

```bash
export OPENCODE_CONFIG=/absolute/path/to/freellmapi/examples/opencode/parallel-search.json
opencode mcp list
opencode
```

OpenCode merges this file with its global and project configuration. It adds only
the `parallel_search` MCP entry, leaving your model, inference provider and other
MCP servers unchanged. If you already use `OPENCODE_CONFIG`, merge the example's
`mcp.parallel_search` object into that file instead. Keep credentials out of the
example; the FreeLLMAPI unified key is used for inference only.

Try asking:

> Use parallel_search to find the official Python asyncio task documentation.
> Then use parallel_search to fetch https://docs.python.org/3/library/asyncio-task.html
> and explain create_task with a source link.

Use a tool-capable model from your FreeLLMAPI catalog. Search results include
excerpts and URLs; fetch is useful when you need details from a specific page.
Search queries and fetched URLs go directly from OpenCode to Parallel. This does
not require enabling FreeLLMAPI's own `/mcp` inference server.

To stop loading the example, unset `OPENCODE_CONFIG`. If you merged the entry
into an existing configuration, set `mcp.parallel_search.enabled` to `false`.
For connection failures, check `opencode mcp list`. For a rate-limit response,
wait before trying again; anonymous access is free, not unlimited.

See [OpenCode's remote MCP configuration](https://opencode.ai/docs/mcp-servers/)
for its configuration and permission controls.
