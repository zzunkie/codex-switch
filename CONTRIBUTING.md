# Contributing

Keep changes focused: this is a small native menu bar utility.

- Native UI: `Sources/MenuContent.swift`.
- App lifecycle and model: `Sources/CodexSwitch.swift` (SwiftUI and AppKit).
- Accounts and helper IPC: `Backend/accounts.mjs`, `rpc.mjs`, and `main.mjs`.
- Reset confirmation and durable request recovery: `Backend/resets.mjs`.
- Configuration recovery: `Backend/config.mjs`.
- HTTP/SSE and WebSocket routing: `Backend/proxy.mjs`.

Use Node.js 24+ to run `node --test Tests/*.test.mjs`. On macOS, also run
`zsh build.sh` and inspect changes with the demo command in the README.

A proxy change should include a local-server regression test. Keep upstreams
fixed, redact credentials, preserve in-flight account isolation, and retain
safe config restoration. Usage windows must come from the server, not assumptions
about a plan name. Do not add real tokens or account fixtures.

For UI changes, check compact layout, readability over light/dark backgrounds, initial focus,
keyboard navigation, and Reduce Motion. Keep dependencies and background work
small. Describe what changed and what you verified in the pull request.

Test reset redemption only with synthetic credits. Real credit consumption requires explicit approval for that one credit. Preserve account binding, fresh eligibility checks, and the pending idempotency key on uncertain results.
