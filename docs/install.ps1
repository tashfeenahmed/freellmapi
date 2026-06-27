# The FreeLLMAPI Windows installer lives at https://freellmapi.co/install.ps1
# This shim keeps old `iwr ... github.io ... | iex` one-liners working.
$ErrorActionPreference = 'Stop'
Invoke-Expression (Invoke-RestMethod -UseBasicParsing https://freellmapi.co/install.ps1)
