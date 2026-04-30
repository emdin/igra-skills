# KAS-USDC Swap Skill

Buy and sell KAS using USDC across chains, routing through Igra L2. Fully gasless — users only need USDC.

Battle-tested on mainnet with 10+ successful trades (2026-04-28/30).

---

## Igra Network Context

**Igra** is an EVM-compatible based rollup built on Kaspa's BlockDAG proof-of-work consensus. Transactions are posted to Kaspa L1 and sequenced by Kaspa's GHOSTDAG consensus. No centralized sequencer, no validator set, no Igra-controlled ordering — making it inherently MEV-resilient.

**Token relationship:**
- **KAS** — native token of Kaspa L1 (8 decimals, unit: sompi, 1 KAS = 1e8 sompi)
- **iKAS** — native gas token of Igra L2 (18 decimals, 1 iKAS = 1 KAS, SOMPI_SCALE = 1e10)
- **WiKAS** — Wrapped iKAS ERC-20 (`0x17Ec...`), like WETH on Ethereum. Needed for DEX swaps.

**Network:**
| Parameter | Value |
|-----------|-------|
| Chain ID | 38833 (0x97B1) |
| RPC | `https://rpc.igralabs.com:8545` |
| WebSocket | `wss://rpc.igralabs.com:8545` |
| Explorer | `https://explorer.igralabs.com` |
| Block time | ~1 second |
| Block gas limit | 10,000,000,000 |
| EVM fork | Prague/Pectra (active from genesis) |
| Gas price | Min 1000 gwei. **MUST use explicit legacy `gasPrice`, NOT EIP-1559.** |
| Tx ordering | FIFO (no MEV) |
| Finality | ~30s practical, 12h formal |

**Key differences from Ethereum:**
- `gasPrice` must be set explicitly (1100 gwei recommended). EIP-1559 `maxFeePerGas` from RPC is wrong.
- Always set `type: 0` on transactions.
- `block.timestamp` runs ~2 minutes ahead of wall clock.
- Reorged transactions are discarded, not re-injected to mempool.
- Transactions silently dropped when `msg.value + gasLimit * gasPrice > balance` (no error).
- Standard Ethereum tooling works: ethers.js, viem, Hardhat, Foundry, MetaMask.

**Bridges:**
- **IGRA native entry** — KAS L1 → iKAS on Igra. Protocol-level, free. Uses `igra_entry_tx` Rust binary that mines a Kaspa TX with payload `[0x92][EVM addr][amount][nonce]` and prefix `97b1`.
- **KAT KasBridge** (`0xb82c5524...`) — iKAS → KAS on L1. Custodial, 3-of-5 FROST threshold signing, ~10 min. Fee: 0.1% (min 10 iKAS floor). `lockForExit(kaspaAddress)` with `msg.value`.
- **Canonical Igra Exit** (`0x4bb88C21...`) — Protocol-level Hyperlane exit. Min 1,000 KAS. Slower. Not used in this skill.
- **Hyperlane warp routes** — USDC/USDT/WETH bridging between Igra and Ethereum/Base/Arbitrum/etc. Trustless, 2/2 validator threshold.

**ZealousSwap** — Uniswap V2 fork on Igra. Has known bugs:
- `router.getAmountsOut()` reverts — must calculate manually
- `pair.token0()` reverts — infer from address sorting (lower = token0)
- `router.WETH()` reverts — WiKAS is used as the native wrapper

**Kaspa address derivation:**
- Same secp256k1 private key derives both EVM and Kaspa addresses
- EVM: keccak256 of uncompressed pubkey → 20 bytes
- Kaspa: bech32 of x-only pubkey (32 bytes, schnorr)
- **CRITICAL:** Kaspa bech32 uses non-standard 40-bit BCH polymod with 8-char checksum. Standard bech32 libraries produce WRONG checksums. Always derive using `igra_entry_tx --dry-run` or the official Kaspa SDK.

**Documentation:** https://igra-labs.gitbook.io/igralabs-docs/
**Gitbook MCP:** `https://igra-labs.gitbook.io/~gitbook/mcp`

---

## How to Use This Skill

### When a user asks to buy KAS:
1. Ask: how much USDC, which chain (Base/Ethereum/Arbitrum), and Kaspa delivery address
2. Create a fresh wallet, compute smart account address
3. Give user the Hyperlane bridge link with smart account as recipient
4. Wait for USDC on Igra, then execute gasless swap → KAS

### When a user asks to sell KAS:
1. Ask: how much KAS, which chain for USDC delivery, and delivery address
2. Create a fresh wallet, derive Kaspa address from Rust binary
3. Ask user to send KAS (amount + 2 for gas) to the Kaspa address
4. Execute: IGRA entry → swap → bridge USDC out

### UX Rules
- **Create a fresh wallet** every time — never reuse
- **Ask explicitly** for amount, chain, and delivery address — never assume
- **Never mention** Bash, scripts, Node.js, .env, or internals
- **Show progress** at every step
- **Handle errors silently** — no debug output to user

---

## Architecture

```
BUY KAS:   USDC (EVM) → Hyperlane → Igra → swap → iKAS → KasBridge → KAS (L1)
SELL KAS:  KAS (L1) → IGRA entry → Igra → swap → USDC → Hyperlane → USDC (EVM)
```

**Buy flow** is fully gasless — all gas paid in USDC via ERC-4337 paymaster. User needs zero iKAS.

**Sell flow** uses sequential transactions — needs ~2 iKAS for gas (bootstrapped from the KAS entry).

---

## Contracts (Igra Mainnet, Chain ID: 38833)

| Contract | Address |
|----------|---------|
| KasBridge (KAT) | `0xb82c5524c5b5c055efb2F8f4AbCcE3173c504f2d` |
| ZealousSwap Router | `0xA5B0946D31aD2d251e0fe2dfEA8808BFd475e607` |
| ZealousSwap Factory | `0x98Bb580A77eE329796a79aBd05c6D2F2b3D5e1bD` |
| WiKAS | `0x17Ec7E1768c813E2a3a9b0f94A35605CA520C242` |
| USDC on Igra | `0xA5b8BF902b2844dA17d4506cc827F7F1681735E7` |
| WiKAS/USDC Pool | `0x7826f5421c324590b1c21d22231c48ad059cbe45` |
| EntryPoint v0.8 | `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` |
| SimpleAccountFactory | `0x13E9ed32155810FDbd067D4522C492D6f68E5944` |
| ERC-20 Paymaster (USDC) | `0xe643D56CBd46b557b11753C6cA579a0da6486CF7` |
| Bundler RPC | `https://bubundler.jobberwocky.co` |
| Hyperlane Mailbox | `0x3a867fCfFeC2B790970eeBDC9023E75B0a172aa7` |
| IGRA entry address (L1) | `kaspa:ppvnxxzm0rr37zpnwux2f2ntvfpr4uqdpm7zsvsztg3en92r7gs0wkmr72q9n` |
| Kaspa gRPC | `grpc://95.217.73.85:16110` (default; use any public kaspad node if unavailable) |

### USDC Hyperlane Warp Routes

| Chain | Warp Route | USDC | Domain |
|-------|-----------|------|--------|
| Ethereum | `0xC3f8B34587EB403FC30a161d6A35cB724A3b273E` | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 1 |
| Base | `0x84e1dF3553B16452AeD7060A4266E4E434f418cC` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 8453 |
| Arbitrum | `0xee9CB26259E98A8F24fc8D265AEfa09B4f3AcAb7` | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | 42161 |
| Optimism | `0xee9CB26259E98A8F24fc8D265AEfa09B4f3AcAb7` | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | 10 |
| Polygon | `0x9f8F71F139C354B7b17E4D8DCb29ddd2A377733D` | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | 137 |
| Avalanche | `0x9f8F71F139C354B7b17E4D8DCb29ddd2A377733D` | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` | 43114 |

**Bridge UI for users:**
```
https://nexus.hyperlane.xyz/?destination=igra&destinationToken=USDC&origin={chain}&originToken=USDC
```
Where `{chain}` = `base`, `ethereum`, `arbitrum`, `optimism`, `polygon`, or `avalanche`.

---

## Buy Flow (Gasless — USDC → KAS)

**User needs:** USDC on any supported chain. Nothing else.
**Time:** ~20s on Igra + ~10 min FROST signing = ~11 min total.
**Latest test:** 3 USDC → 73.65 KAS, 567s, zero iKAS needed.

### Steps

```
1. Create wallet, compute smart account address
2. User bridges USDC to smart account via Hyperlane
3. UserOp 1 (gas: USDC): create account + approve paymaster + swap USDC→WiKAS
4. UserOp 2 (gas: USDC): unwrap WiKAS→iKAS
5. UserOp 3 (gas: USDC): lockForExit (full balance, single exit)
6. Wait for FROST signing + L1 release (~10 min)
```

### Smart Account Address

```javascript
const factory = new ethers.Contract("0x13E9ed32155810FDbd067D4522C492D6f68E5944",
  ["function getAddress(address,uint256) view returns (address)"], provider);
const smartAccount = await factory.getAddress(eoaAddress, 0n);
// User bridges USDC to this address on Igra
```

### UserOp Helper (gasless via paymaster)

Every UserOp follows this sequence:
1. Build UserOp with high initial gas limits
2. Call `pm_sponsorUserOperation` → get guarantor paymaster data
3. Call `eth_estimateUserOperationGas` → update gas fields
4. Call `pm_sponsorUserOperation` AGAIN (gas changed → new guarantor sig)
5. Sign with raw ECDSA (`signingKey.sign(hash)`, NOT `signMessage`)
6. `eth_sendUserOperation` → submit
7. Poll `eth_getUserOperationReceipt` every 1 second (timeout 10s)

```javascript
async function rpc(method, params) {
  const r = await fetch("https://bubundler.jobberwocky.co", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

async function sendUserOp(provider, wallet, smartAccount, callData, isFirstUserOp) {
  const EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
  const FACTORY = "0x13E9ed32155810FDbd067D4522C492D6f68E5944";

  const nonce = await new ethers.Contract(EP,
    ["function getNonce(address,uint192) view returns (uint256)"], provider)
    .getNonce(smartAccount, 0);

  const dummySig = ethers.Signature.from(
    wallet.signingKey.sign(ethers.keccak256("0x00"))
  ).serialized;

  const op = {
    sender: smartAccount.toLowerCase(),
    nonce: ethers.toBeHex(nonce),
    callData,
    callGasLimit: "0xF4240",         // 1M — high for estimation
    verificationGasLimit: "0x7A120", // 500k — high for estimation
    preVerificationGas: "0x186A0",
    maxFeePerGas: "0xe8d4a51000",    // 1000 gwei minimum
    maxPriorityFeePerGas: "0xe8d4a51000",
    signature: dummySig,
  };

  // First UserOp: include factory to deploy smart account
  if (isFirstUserOp) {
    op.factory = FACTORY.toLowerCase();
    op.factoryData = new ethers.Interface(
      ["function createAccount(address,uint256) returns (address)"]
    ).encodeFunctionData("createAccount", [wallet.address, 0n]);
  }

  // 1. Get paymaster sponsorship (guarantor mode)
  const sponsor = await rpc("pm_sponsorUserOperation", [op, EP]);
  op.paymaster = sponsor.paymaster;
  op.paymasterData = sponsor.paymasterData;
  op.paymasterVerificationGasLimit = sponsor.paymasterVerificationGasLimit;
  op.paymasterPostOpGasLimit = sponsor.paymasterPostOpGasLimit;

  // 2. Estimate gas
  const gas = await rpc("eth_estimateUserOperationGas", [op, EP]);
  op.callGasLimit = gas.callGasLimit;
  op.verificationGasLimit = gas.verificationGasLimit;
  op.preVerificationGas = gas.preVerificationGas;
  if (gas.paymasterVerificationGasLimit) op.paymasterVerificationGasLimit = gas.paymasterVerificationGasLimit;
  if (gas.paymasterPostOpGasLimit) op.paymasterPostOpGasLimit = gas.paymasterPostOpGasLimit;

  // 3. Re-sponsor (gas values changed)
  const sponsor2 = await rpc("pm_sponsorUserOperation", [op, EP]);
  op.paymasterData = sponsor2.paymasterData;

  // 4. Sign (raw ECDSA — NOT signMessage)
  const initCode = isFirstUserOp
    ? FACTORY.toLowerCase() + op.factoryData.slice(2)
    : "0x";
  const pmV = BigInt(op.paymasterVerificationGasLimit).toString(16).padStart(32, "0");
  const pmP = BigInt(op.paymasterPostOpGasLimit).toString(16).padStart(32, "0");
  const pmAndData = op.paymaster.toLowerCase() + pmV + pmP + op.paymasterData.slice(2);

  function packBytes32(a, b) {
    return "0x" + BigInt(a).toString(16).padStart(32, "0") + BigInt(b).toString(16).padStart(32, "0");
  }

  const hash = await new ethers.Contract(EP, [{
    name: "getUserOpHash", type: "function", stateMutability: "view",
    inputs: [{ type: "tuple", name: "userOp", components: [
      { type: "address", name: "sender" }, { type: "uint256", name: "nonce" },
      { type: "bytes", name: "initCode" }, { type: "bytes", name: "callData" },
      { type: "bytes32", name: "accountGasLimits" }, { type: "uint256", name: "preVerificationGas" },
      { type: "bytes32", name: "gasFees" }, { type: "bytes", name: "paymasterAndData" },
      { type: "bytes", name: "signature" },
    ]}], outputs: [{ type: "bytes32" }],
  }], provider).getUserOpHash({
    sender: smartAccount, nonce, initCode, callData,
    accountGasLimits: packBytes32(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: packBytes32(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData: pmAndData, signature: "0x",
  });
  op.signature = ethers.Signature.from(wallet.signingKey.sign(hash)).serialized;

  // 5. Submit
  const opHash = await rpc("eth_sendUserOperation", [op, EP]);

  // 6. Wait (1s intervals, 10s timeout)
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const receipt = await rpc("eth_getUserOperationReceipt", [opHash]);
      if (receipt) return receipt;
    } catch {}
  }
  throw new Error("UserOp not mined in 10s");
}
```

### Buy Flow Implementation

```javascript
const USDC = "0xA5b8BF902b2844dA17d4506cc827F7F1681735E7";
const WIKAS = "0x17Ec7E1768c813E2a3a9b0f94A35605CA520C242";
const ROUTER = "0xA5B0946D31aD2d251e0fe2dfEA8808BFd475e607";
const POOL = "0x7826f5421c324590b1c21d22231c48ad059cbe45";
const KASBRIDGE = "0xb82c5524c5b5c055efb2F8f4AbCcE3173c504f2d";
const PAYMASTER = "0xe643D56CBd46b557b11753C6cA579a0da6486CF7";

const approve = new ethers.Interface(["function approve(address,uint256) returns (bool)"]);

function batch(calls) {
  return new ethers.Interface([
    "function executeBatch((address target, uint256 value, bytes data)[] calls)",
  ]).encodeFunctionData("executeBatch", [calls]);
}

function getAmountOut(amountIn, reserveIn, reserveOut) {
  const f = amountIn * 997n;
  return (f * reserveOut) / (reserveIn * 1000n + f);
}

// UserOp 1: create account + approve paymaster + approve router + swap USDC→WiKAS
const usdcBalance = await usdcContract.balanceOf(smartAccount);
const swapAmount = usdcBalance * 90n / 100n; // 90% to swap, 10% buffer for gas fees
const [r0, r1] = await poolContract.getReserves(); // token0=WiKAS, token1=USDC
const block = await provider.getBlock("latest");

await sendUserOp(provider, wallet, smartAccount, batch([
  { target: USDC, value: 0n, data: approve.encodeFunctionData("approve", [PAYMASTER, ethers.MaxUint256]) },
  { target: USDC, value: 0n, data: approve.encodeFunctionData("approve", [ROUTER, swapAmount]) },
  { target: ROUTER, value: 0n, data: new ethers.Interface([
    "function swapExactTokensForTokens(uint,uint,address[],address,uint) returns (uint[])",
  ]).encodeFunctionData("swapExactTokensForTokens", [
    swapAmount, 0n, [USDC, WIKAS], smartAccount, block.timestamp + 600,
  ])},
]), true); // isFirstUserOp = true

// UserOp 2: unwrap WiKAS → iKAS
const wikasBalance = await wikasContract.balanceOf(smartAccount);
await sendUserOp(provider, wallet, smartAccount, batch([
  { target: WIKAS, value: 0n, data: new ethers.Interface([
    "function withdraw(uint256)",
  ]).encodeFunctionData("withdraw", [wikasBalance]) },
]));

// UserOp 3: lockForExit (full balance)
const ikasBalance = await provider.getBalance(smartAccount);
const exitAmount = ikasBalance - ethers.parseEther("0.1"); // minimal buffer
await sendUserOp(provider, wallet, smartAccount, batch([
  { target: KASBRIDGE, value: exitAmount, data: new ethers.Interface([
    "function lockForExit(bytes) payable",
  ]).encodeFunctionData("lockForExit", [ethers.toUtf8Bytes(kaspaAddress)]) },
]));

// Wait for L1 release (~10 min)
while (true) {
  const exit = await kasBridge.exits(exitId);
  if (exit.processed && exit.kaspaTxHash !== ethers.ZeroHash) break;
  await new Promise(r => setTimeout(r, 15_000));
}
```

---

## Sell Flow (KAS → USDC)

**User needs:** KAS on Kaspa L1. Send amount + 2 KAS (for Igra gas).
**Time:** ~70 seconds total.
**Latest test:** 32 KAS → 0.946 USDC on Base, 69s.

### Steps

```
1. Create wallet, derive Kaspa address from Rust binary
2. User sends KAS to the Kaspa address
3. IGRA native entry: KAS → iKAS on Igra (free, ~5s)
4. Wrap iKAS → WiKAS → swap to USDC → bridge to destination chain
5. Wait for Hyperlane relay (~40s)
```

### Implementation

```javascript
const GP = 1_100_000_000_000n; // 1100 gwei — MUST use explicit legacy gasPrice

// Step 1: IGRA entry (KAS L1 → iKAS on Igra)
// Use igra_entry_tx binary — free, no bridge fee
execSync(`igra_entry_tx --preset mainnet --private-key ${key} --recipient ${evmAddr} --amount ${amount}`,
  { timeout: 60_000 });
// Wait for iKAS arrival (~3-7s)

// Step 2: Wrap iKAS → WiKAS (keep 1.5 iKAS for gas)
const wrapAmount = ikasBalance - ethers.parseEther("1.5");
await wikas.deposit({ value: wrapAmount, gasPrice: GP, type: 0 });

// Step 3: Approve + Swap WiKAS → USDC
await wikas.approve(ROUTER, wrapAmount, { gasPrice: GP, type: 0 });
await router.swapExactTokensForTokens(
  wrapAmount, minOut, [WIKAS, USDC], wallet.address, deadline,
  { gasPrice: GP, gasLimit: 300_000n, type: 0 }
);

// Step 4: Approve + Bridge USDC out
await usdc.approve(USDC, ethers.MaxUint256, { gasPrice: GP, type: 0 });
const bridgeAmount = usdcBalance * 999n / 1000n; // -0.1% Hyperlane fee
const gasPayment = await usdc.quoteGasPayment(destDomain);
await usdc.transferRemote(destDomain, recipient32, bridgeAmount,
  { value: gasPayment, gasPrice: GP, gasLimit: 350_000n, type: 0 }
);
// Wait for Hyperlane relay (~40s)
```

---

## Key Parameters

| Parameter | Value |
|-----------|-------|
| Igra Chain ID | 38833 |
| Igra RPC | `https://rpc.igralabs.com:8545` |
| Gas price | `1100` gwei (explicit legacy, NEVER EIP-1559) |
| Block time | ~1 second |
| KasBridge exit min | 10 iKAS (net, after fee) |
| KasBridge exit max | 5,000 iKAS per tx |
| KasBridge exit fee | 0.1% (min 10 iKAS floor) |
| KasBridge exit timing | ~10 min (FROST signing) |
| KasBridge refund | `claimRefund(exitId)` after 172,800 blocks (~48h) |
| Hyperlane bridge time | 30-90s |
| Hyperlane protocol fee | ~0.1% |
| ZealousSwap LP fee | 0.3% |
| Pool liquidity | ~22K USDC (max ~$795 for <1% impact) |
| Paymaster gas cost | ~0.05 USDC per UserOp |

---

## Gotchas

### Igra Network

1. **Gas price: explicit legacy only.** `gasPrice: 1100000000000n, type: 0`. RPC returns wrong EIP-1559 values.

2. **Silent tx rejection.** If `msg.value + gasLimit * gasPrice > balance`, tx is dropped with no error. Always compute `maxValue = balance - (gasLimit * gasPrice)`.

3. **Block timestamps run ~2 min ahead.** Use `block.timestamp + 600` for swap deadlines.

4. **FIFO ordering.** No MEV, no gas-price priority.

5. **Reorged txs are discarded.** Must resubmit.

### ZealousSwap

6. **`getAmountsOut()` REVERTS.** Calculate manually: `out = (in * 997 * rOut) / (rIn * 1000 + in * 997)`.

7. **`token0()` REVERTS.** Infer from address sorting (lower = token0). WiKAS/USDC pool: token0 = WiKAS, token1 = USDC.

8. **Pool liquidity ~22K USDC.** Split swaps above ~$795.

### KasBridge

9. **Custodial** (KAT Alliance 3-of-5 FROST).

10. **lockForExit needs 350k gasLimit** (uses ~273k). 200k causes out-of-gas revert.

11. **Kaspa address checksum NOT validated on-chain** — relayers validate it. Bad checksum = exit stuck forever. Always derive from `igra_entry_tx --dry-run`.

12. **Kaspa bech32 is non-standard.** 40-bit BCH polymod, 8-char checksum. Standard bech32 libraries produce WRONG checksums. Never roll your own — use the Rust binary.

### Hyperlane

13. **Approve with MaxUint256.** Exact amount fails on some warp routes.

14. **`transferRemote` takes ~0.1% fee.** Bridging full balance reverts ("burn exceeds balance"). Use `balance * 999 / 1000`.

15. **USDC on Igra IS the warp route** (same contract). Self-approve needed.

### Bundler / Paymaster

16. **UserOp format is v0.8 unpacked.** Use `factory`+`factoryData` (NOT `initCode`). Use `paymaster`+`paymasterData` (NOT `paymasterAndData`).

17. **Raw ECDSA signing.** Use `signingKey.sign(hash)`, NOT `signMessage()` (no EIP-191 prefix).

18. **Dummy sig for estimation must be valid ECDSA.** Sign any hash with the real key. `0xff...ff` causes AA23 revert.

19. **Must re-sponsor after gas estimation.** Gas values change → guarantor signature invalidates → call `pm_sponsorUserOperation` again.

20. **High initial gas limits for native value UserOps.** Set `callGasLimit: 0xF4240` (1M) and `verificationGasLimit: 0x7A120` (500k) before estimation. Otherwise estimation reverts for large native value transfers.

21. **Poll receipt every 1 second, timeout 10 seconds.** Igra blocks are 1s. If not mined in 10s, something is wrong.

### Key Management

22. **One key, all chains.** Same secp256k1 key → EVM address (keccak256) + Kaspa address (bech32 x-only pubkey).

23. **Never log, hardcode, or pass keys as CLI args.** Load from env at point of use only.

---

## OPSEC

- Never output, print, or log private keys — not even partially
- Never write keys into source files or git-tracked files
- Never pass keys as CLI arguments (visible in `ps aux`) — use env vars
- Load from `process.env.PRIVATE_KEY` at runtime only
- Confirm `.env` is in `.gitignore`
- If exposed, warn user and recommend rotation immediately

---

## Tooling & Dependencies

### Buy flow (USDC → KAS)

The buy flow is **pure JavaScript** — no binaries needed. Requires:
- Node.js (v18+)
- `ethers` (v6) — `npm install ethers`
- Network access to Igra RPC and bundler

All operations use the ERC-4337 bundler + paymaster. The code in this skill is self-contained.

### Sell flow (KAS → USDC)

The sell flow needs both JavaScript and the `igra_entry_tx` Rust binary.

**`igra_entry_tx`** — constructs and submits an IGRA entry transaction on Kaspa L1. This is the only way to bridge KAS → iKAS.

**What it does (no magic):**
1. Takes a private key, EVM recipient address, and KAS amount
2. Derives the Kaspa address (secp256k1 x-only pubkey → bech32)
3. Fetches UTXOs from Kaspa gRPC
4. Builds a Kaspa transaction with payload `[0x92][20-byte EVM addr][8-byte amount LE][4-byte nonce]`
5. Mines the nonce until the Kaspa TX ID starts with prefix `97b1` (~10-100ms)
6. Signs with schnorr, validates mass, submits to Kaspa gRPC
7. Prints JSON result to stdout: `{ kaspa_tx_id, recipient, amount_kas, status }`

**Source code:** `igra-foundry/crates/igra-kaspa-derive/src/bin/igra_entry_tx.rs`
- ~490 lines of Rust
- Uses official Kaspa crates: `kaspa-consensus-core`, `kaspa-grpc-client`, `kaspa-bip32`, `kaspa-addresses`, `kaspa-txscript`
- No network calls except Kaspa gRPC (fetching UTXOs and submitting the tx)
- The private key is passed via `--private-key` flag or `IGRA_PRIVATE_KEY` env var
- `--dry-run` mode builds and mines but doesn't submit — useful for deriving the Kaspa address

**To compile from source:**
```bash
# Clone the repo
git clone https://github.com/IgraLabs/foundry.git igra-foundry
cd igra-foundry

# Build the binary (requires Rust toolchain: https://rustup.rs)
cargo build --release -p igra-kaspa-derive --bin igra_entry_tx

# Binary at: target/release/igra_entry_tx

# Verify it works:
./target/release/igra_entry_tx --help
```

**Rust dependencies** (from `Cargo.toml`):
- `kaspa-consensus-core` — tx types, signing, mass calculation
- `kaspa-grpc-client` — gRPC connection to kaspad
- `kaspa-bip32` — secp256k1 key derivation
- `kaspa-addresses` — Kaspa bech32 encoding (non-standard 40-bit polymod)
- `kaspa-txscript` — script building (`pay_to_address_script`)
- `alloy-*` — EVM address derivation
- `clap` — CLI argument parsing

**If you can't compile Rust**, the buy flow works without it. For the sell flow, you would need someone to provide a trusted prebuilt binary, or implement the entry transaction logic in another language (non-trivial due to the Kaspa bech32 checksum and TX ID mining).

### JavaScript helper scripts

These scripts are in the `igra-skills/` directory alongside this skill file:

| Script | Purpose | Dependencies |
|--------|---------|-------------|
| `generate-wallet.js` | Generate EVM + Kaspa addresses from one key | ethers |
| `buy-kas.js` | Sequential buy flow (USDC→KAS) | ethers, dotenv |
| `sell-kas.js` | Sequential sell flow (KAS→USDC) | ethers, dotenv, igra_entry_tx |
| `swap-roundtrip.js` | Full round-trip with progress bars | ethers, dotenv, igra_entry_tx |
| `swap-demo.js` | Interactive demo with user prompts | ethers, dotenv, igra_entry_tx |
| `bundler-poc.js` | ERC-4337 bundler proof of concept | ethers, dotenv |

**Setup:**
```bash
cd igra-skills
npm install ethers dotenv
```

**Security notes:**
- All scripts load the private key from `.env` at runtime — never hardcoded
- `.env` is gitignored and chmod 600
- Scripts never log, print, or transmit the private key
- The Rust binary handles key material only in memory — never writes it to disk
- All network calls go to: Igra RPC (`rpc.igralabs.com`), Kaspa gRPC (default `95.217.73.85:16110`, or any public kaspad node), bundler (`bubundler.jobberwocky.co`), and Hyperlane relayers

---

## Live Test Results (2026-04-30)

### Gasless Buy: 3 USDC → 73.65 KAS

| Step | Time |
|------|------|
| Create account + swap USDC→WiKAS | 6s |
| Unwrap WiKAS→iKAS | 6s |
| lockForExit (full balance, single exit) | 7s |
| FROST signing + L1 release | ~9 min |
| **Total** | **567s** |

Gas: 0.05 USDC (paymaster). iKAS needed: **ZERO**.
KasBridge fee: 10 iKAS ($0.33).

### Sell: 32 KAS → 0.946 USDC on Base

| Step | Time |
|------|------|
| IGRA entry (free) | 4s |
| Wrap + approve + swap | 17s |
| Approve + bridge | 11s |
| Hyperlane relay | 37s |
| **Total** | **69s** |

Gas: ~0.6 iKAS ($0.02). IGRA entry fee: $0 (free).

---

## Fee Summary

| Fee | Buy (gasless) | Sell |
|-----|--------------|------|
| IGRA entry | — | $0 (free) |
| Paymaster gas (USDC) | ~$0.05 | — |
| Igra gas (iKAS) | — | ~$0.02 |
| ZealousSwap LP (0.3%) | 0.3% | 0.3% |
| KasBridge exit (10 iKAS) | ~$0.33 | — |
| Hyperlane fee (0.1%) | — | 0.1% |
| **Total fixed costs** | **~$0.38** | **~$0.02** |

At $100+ trades, fixed costs are <0.5%. LP fee (0.3%) dominates.

---

## Canonical Igra Exit Bridge (NOT used)

Protocol-level exit at `0x4bb88C213d3eD9dc4bae694f1bc1bF745903b2d0`:
- Min 1,000 KAS (vs 10 iKAS on KasBridge)
- Slower, Hyperlane-based
- Function: `requestExit(kasPayoutAddress, unlockAmountSompi)` with `msg.value = (amount + fee) * 1e10`

This skill uses KAT KasBridge for lower minimums and faster settlement.

---

## Quex Oracle Price Feeds

| Pair | Address |
|------|---------|
| KAS/USD | `0xd4D0cbbd05FBf1cAEb4c56956D992C5CCCdcD88e` |
| USDC/USD | `0x06Bc2d4ed8Caf9DFfa8EAead325e7Ecb4E1489a2` |

Chainlink-compatible: `latestRoundData()`.

---

## Igra Faucet API

```javascript
// 1. Get challenge
const { challenge } = await (await fetch("https://faucet.igralabs.com/api/mainnet/challenge", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address: wallet.address }),
})).json();

// 2. Sign + claim
const signature = await wallet.signMessage(challenge);
await fetch("https://faucet.igralabs.com/api/mainnet/drip", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address: wallet.address, signature, challenge }),
});
// Returns 0.1 iKAS, once per day. Only enough for simple transfers, NOT swaps.
```
