# igra-skills

Skills for AI coding agents (Claude Code, Cursor, etc.) to interact with the [Igra Network](https://igra-labs.gitbook.io/igralabs-docs/) — an EVM-compatible based rollup on Kaspa.

## Skills

### [kas-usdc-swap.md](kas-usdc-swap.md)

Buy and sell KAS using USDC across chains, routing through Igra L2. Fully gasless buy flow — users only need USDC.

**What it does:**
- **Buy KAS:** USDC (Ethereum/Base/Arbitrum/etc.) → Igra → swap → KAS on Kaspa L1
- **Sell KAS:** KAS on Kaspa L1 → Igra → swap → USDC on any EVM chain

**Key features:**
- Gasless buy via ERC-4337 paymaster (zero iKAS needed, all gas paid in USDC)
- Hyperlane cross-chain USDC bridging (6 source chains)
- ZealousSwap DEX integration with known gotcha workarounds
- KAT KasBridge exit with FROST threshold signing
- Free IGRA native entry for sell flow
- Full progress display with timing

### [secrets-opsec.md](secrets-opsec.md)

Private key and secrets OPSEC rules for AI agents working with wallets and cryptographic credentials. Covers:

- What to never do with keys (logging, hardcoding, CLI args, persisting)
- How to always handle keys (env vars, .env, chmod 600)
- Encrypted keystore pattern for production
- Handling keys shared in conversation
- Incident response for accidental exposure

**Use this skill** as a baseline for any AI agent that handles private keys, seed phrases, or wallet operations.

## Helper Scripts

| Script | Purpose |
|--------|---------|
| `generate-wallet.js` | Generate EVM + Kaspa addresses from one key |
| `buy-kas.js` | Sequential buy flow (USDC → KAS) |
| `sell-kas.js` | Sequential sell flow (KAS → USDC) |
| `swap-roundtrip.js` | Full round-trip with progress bars |
| `swap-demo.js` | Interactive demo with user prompts |
| `bundler-poc.js` | ERC-4337 bundler proof of concept |

## Setup

```bash
npm install ethers dotenv
```

For the sell flow, you also need the `igra_entry_tx` Rust binary:

```bash
git clone https://github.com/IgraLabs/foundry.git igra-foundry
cd igra-foundry
cargo build --release -p igra-kaspa-derive --bin igra_entry_tx
```

See [kas-usdc-swap.md](kas-usdc-swap.md#tooling--dependencies) for full details on what the binary does and its dependencies.

## Security

- No private keys, seeds, or secrets in any file
- `.env` is gitignored and must be chmod 600
- All scripts load keys from environment variables at runtime
- The Rust binary source is fully auditable at [IgraLabs/foundry](https://github.com/IgraLabs/foundry)
- See [secrets-opsec.md](secrets-opsec.md) for complete OPSEC guidelines

## License

MIT
