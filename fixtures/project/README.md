# ACP integration fixture

Disposable input for agent-workbench M0. No credentials or external dependencies.
`token.mjs` intentionally has a boundary bug: a token expires when `expiry <= now`.
This directory is copied into each Run; the source fixture must remain unchanged.
