# igra-skills

Skills for AI coding agents (Claude Code, Cursor, etc.) to interact with the [Igra Network](https://igra-labs.gitbook.io/igralabs-docs/) — an EVM-compatible based rollup on Kaspa.

## Structure

```
skills/
  kas-usdc-swap/
    kas-usdc-swap.md      # Skill doc
    scripts/              # Helper scripts (Node.js)
    demo/                 # Demo videos
  secrets-opsec/
    secrets-opsec.md      # OPSEC rules for AI agents
```

## Skills

### [kas-usdc-swap](skills/kas-usdc-swap/kas-usdc-swap.md)

Buy and sell KAS using USDC across chains, routing through Igra.

- **Buy KAS:** USDC (Ethereum/Base/Arbitrum/etc.) → Igra → swap → KAS on Kaspa L1
- **Sell KAS:** KAS on Kaspa L1 → Igra → swap → USDC on any EVM chain
- Gasless buy via ERC-4337 paymaster (zero iKAS needed, all gas paid in USDC)
- Hyperlane cross-chain USDC bridging (6 source chains)
- Free IGRA native entry for sell flow

Demo: [buy](skills/kas-usdc-swap/demo/buy-kas.mp4) | [sell](skills/kas-usdc-swap/demo/sell-kas.mp4)

### [secrets-opsec](skills/secrets-opsec/secrets-opsec.md)

OPSEC rules for AI agents working with wallets and cryptographic credentials.

- What to never do with keys (logging, hardcoding, CLI args, persisting)
- How to always handle keys (env vars, .env, chmod 600)
- Encrypted keystore pattern for production
- Handling keys shared in conversation
- Incident response for accidental exposure

**Use this skill** as a baseline for any AI agent that handles private keys, seed phrases, or wallet operations.

## Helper Scripts

| Script | Purpose |
|--------|---------|
| [`generate-wallet.js`](skills/kas-usdc-swap/scripts/generate-wallet.js) | Generate EVM + Kaspa addresses from one key |
| [`buy-kas-gasless.js`](skills/kas-usdc-swap/scripts/buy-kas-gasless.js) | Gasless buy flow via ERC-4337 (USDC → KAS) |
| [`buy-kas.js`](skills/kas-usdc-swap/scripts/buy-kas.js) | Sequential buy flow (USDC → KAS, needs iKAS for gas) |
| [`sell-kas.js`](skills/kas-usdc-swap/scripts/sell-kas.js) | Sequential sell flow (KAS → USDC) |
| [`swap-roundtrip.js`](skills/kas-usdc-swap/scripts/swap-roundtrip.js) | Full round-trip with progress bars |
| [`swap-demo.js`](skills/kas-usdc-swap/scripts/swap-demo.js) | Interactive demo with user prompts |
| [`bundler-poc.js`](skills/kas-usdc-swap/scripts/bundler-poc.js) | ERC-4337 bundler proof of concept |

## Setup

```bash
cd skills/kas-usdc-swap/scripts
npm install
```

For the sell flow, you also need the `igra_entry_tx` Rust binary:

```bash
git clone https://github.com/IgraLabs/foundry.git igra-foundry
cd igra-foundry
cargo build --release -p igra-kaspa-derive --bin igra_entry_tx
```

See [kas-usdc-swap.md](skills/kas-usdc-swap/kas-usdc-swap.md#tooling--dependencies) for full details on what the binary does and its dependencies.

## Security

- No private keys, seeds, or secrets in any file
- `.env` is gitignored and must be chmod 600
- All scripts load keys from environment variables at runtime
- The Rust binary source is fully auditable at [IgraLabs/foundry](https://github.com/IgraLabs/foundry)
- See [secrets-opsec.md](skills/secrets-opsec/secrets-opsec.md) for complete OPSEC guidelines

## Adding Skills

Create a folder under `skills/` with at minimum a skill `.md` file. Add `scripts/` and `demo/` subfolders as needed. The skill doc should be self-contained.

## License

MIT
