# Security

Report credential exposure, unsafe forwarding, or configuration corruption
through [GitHub private vulnerability reporting](https://github.com/zzunkie/codex-switch/security/advisories/new).
Do not include real tokens, account directories, config backups, or unredacted
screenshots in a public issue.

Only the latest release is maintained. This project is experimental and has not
received an independent security audit. The local route secret protects against
accidental or browser-origin access; it does not protect against software already
running as your macOS user. Added-account credentials and config backups are
sensitive local files.
