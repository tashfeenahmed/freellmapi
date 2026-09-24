# FreeLLMAPI -> ChatGPT private MCP connection.
# Secrets are read from environment variables and are never stored here.
config_version: 1

control_plane:
  # Replace this non-secret placeholder with the tunnel id from OpenAI Platform.
  tunnel_id: tunnel_00000000000000000000000000000000
  api_key: env:CONTROL_PLANE_API_KEY

mcp:
  server_urls:
    - channel: main
      url: http://127.0.0.1:3001/mcp
  # Set FREELLMAPI_MCP_AUTHORIZATION to the complete value
  # "Bearer freellmapi-..." in the process environment.
  extra_headers:
    Authorization: env:FREELLMAPI_MCP_AUTHORIZATION
  discovery_extra_headers:
    Authorization: env:FREELLMAPI_MCP_AUTHORIZATION
  startup_wait_timeout: 60s

health:
  listen_addr: 127.0.0.1:0

admin_ui:
  open_browser: false
