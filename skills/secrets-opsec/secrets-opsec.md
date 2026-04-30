# AI Agent Private Key & Secrets OPSEC

Rules for AI agents (Claude Code, Cursor, etc.) working with wallets, private keys, and cryptographic secrets.

---

## NEVER do

- Never output, echo, print, or log private keys, seed phrases, mnemonics, or master seeds — not even partially
- Never write private keys into source files, scripts, memory files, or any file tracked by git
- Never include private keys in tool call arguments that could be logged (e.g., commit messages, PR descriptions, task descriptions)
- Never pass key values as arguments between tool calls in agentic loops — only load from env at the point of use
- Never store private keys in MEMORY.md or any persistent memory/context file
- Never read .env files unless the user explicitly asks — and never reproduce key values in output
- Never associate stored addresses with their corresponding private keys in any persisted context
- Never send keys over network calls, webhooks, or external APIs
- Never extract or reference private keys from screenshots or images the user shares
- Never include key values in error messages, stack traces, or exception output
- Never pass key values as CLI arguments to subprocesses — they are visible in process listings (e.g., `ps aux`)
- Never persist key values in objects or files beyond the scope where they are immediately needed

## ALWAYS do

- Load keys exclusively from environment variables or .env files at runtime, at the point of use
- Reference keys by variable name only (e.g., `process.env.PRIVATE_KEY`), never by value
- When showing code examples involving wallets, use placeholder values like `0x_YOUR_PRIVATE_KEY`
- If asked to derive an address from a key, output only the address — never echo the key back
- Confirm `.env` is in `.gitignore` before any git operations
- Ensure `.env` has restrictive file permissions (`chmod 600`)
- If a script needs a key, ensure it reads from `.env` — never hardcode
- When using CI/CD pipelines (GitHub Actions, Docker builds, etc.), confirm keys are stored as encrypted secrets in the pipeline, never as plaintext env vars in config files

## Preferred: Encrypted Keystores

Encrypted keystores eliminate plaintext keys on disk entirely. Ethers v6 supports this natively:

```javascript
const wallet = await ethers.Wallet.fromEncryptedJson(keystoreJson, password);
```

The keystore file is safe to store on disk; only the password needs protection. Recommend this pattern when the user is ready to move beyond `.env`-based key management.

## When the user shares a key in conversation

- Warn the user that keys shared in chat are saved to the conversation transcript on disk
- Use it for the immediate task only — never persist it to any file or memory
- Recommend the user rotate the key if the associated address holds real funds, since the transcript is stored in plaintext
- If the key remains in context across a long session, attempt to remind the user at session end to rotate it — note this is best-effort, as context compaction may drop earlier messages

## If a key is accidentally exposed

- Immediately warn the user
- Recommend rotating the key and moving funds if the address holds real value
- Help the user scrub the exposure (e.g., remove from git history with `git filter-repo`, delete log files)

## Persistence between sessions

- Keys persist via the user's `.env` files on disk — these survive between sessions naturally
- Scripts reference `process.env.PRIVATE_KEY` (or similar) — this pattern is already in place
- For higher security, migrate to encrypted keystores (see above)
