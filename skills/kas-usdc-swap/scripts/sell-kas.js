/**
 * Sell KAS for USDC (Kaspa L1 -> Igra -> USDC on Base)
 *
 * Flow:
 *   1. IGRA native entry: KAS (L1) -> iKAS (Igra)    [Rust binary]
 *   2. Wrap iKAS -> WiKAS                             [Igra]
 *   3. Swap WiKAS -> USDC on ZealousSwap              [Igra]
 *   4. Hyperlane bridge USDC out to Base               [Igra]
 *
 * Prerequisites:
 *   - KAS on Kaspa L1 at the wallet's Kaspa address
 *   - iKAS on Igra for gas (~1 iKAS minimum)
 *   - igra_entry_tx binary compiled
 *
 * Usage: node sell-kas.js [amount_kas]
 *   e.g. node sell-kas.js 20    (sell 20 KAS)
 */

const { ethers } = require("ethers");
const { execSync } = require("child_process");
require("dotenv").config();

// ── Config ───────────────────────────────────────────────────────────

const IGRA_RPC = "https://rpc.igralabs.com:8545";
const GAS_PRICE = 1_100_000_000_000n; // 1100 gwei
const BASE_DOMAIN = 8453;

// Igra contracts
const WIKAS = "0x17Ec7E1768c813E2a3a9b0f94A35605CA520C242";
const USDC_IGRA = "0xA5b8BF902b2844dA17d4506cc827F7F1681735E7";
const ROUTER = "0xA5B0946D31aD2d251e0fe2dfEA8808BFd475e607";
const POOL = "0x7826f5421c324590b1c21d22231c48ad059cbe45";

// Path to igra_entry_tx binary
const ENTRY_TX_BIN = "/Users/emdin/Projects/igra/tmp/igra-foundry/target/release/igra_entry_tx";

// ── ABIs ─────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const WIKAS_ABI = [
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint,uint,address[],address,uint) returns (uint[])",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
];

const WARP_ABI = [
  "function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32)",
  "function quoteGasPayment(uint32 destination) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

// ── Helpers ──────────────────────────────────────────────────────────

function getAmountOut(amountIn, reserveIn, reserveOut) {
  const aif = amountIn * 997n;
  return (aif * reserveOut) / (reserveIn * 1000n + aif);
}

function log(step, msg) {
  console.log(`[${step}] ${msg}`);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const key = process.env.PRIVATE_KEY;
  if (!key) throw new Error("Set PRIVATE_KEY in .env");

  const amountKas = parseFloat(process.argv[2] || "0");
  if (amountKas <= 0) {
    console.log("Usage: node sell-kas.js <amount_kas>");
    console.log("  e.g. node sell-kas.js 20");
    process.exit(1);
  }

  const igraProvider = new ethers.JsonRpcProvider(IGRA_RPC);
  const igraWallet = new ethers.Wallet(key, igraProvider);
  const addr = igraWallet.address;

  console.log("=== Sell KAS for USDC ===");
  console.log(`Wallet: ${addr}`);
  console.log(`Amount: ${amountKas} KAS\n`);

  // ── Check Igra gas balance ──
  const igraBalance = await igraProvider.getBalance(addr);
  log("0", `Igra iKAS: ${ethers.formatEther(igraBalance)}`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 1: IGRA native entry (KAS L1 -> iKAS on Igra)
  // ══════════════════════════════════════════════════════════════════

  log("1", `Sending ${amountKas} KAS to IGRA entry (mining TX ID prefix 97b1)...`);

  const balanceBefore = await igraProvider.getBalance(addr);

  try {
    // IMPORTANT: key is passed via env var, NOT as CLI argument (visible in ps)
    const result = execSync(
      `${ENTRY_TX_BIN} --preset mainnet --recipient ${addr} --amount ${amountKas}`,
      {
        env: { ...process.env, IGRA_PRIVATE_KEY: key.startsWith("0x") ? key.slice(2) : key },
        timeout: 180_000, // 3 min for mining
        encoding: "utf-8",
      }
    );
    const parsed = JSON.parse(result.trim());
    log("1", `Entry tx submitted: ${parsed.kaspa_tx_id}`);
    log("1", `Status: ${parsed.status}`);
  } catch (err) {
    // igra_entry_tx prints JSON to stdout, logs to stderr
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";
    if (stdout.includes("kaspa_tx_id")) {
      const parsed = JSON.parse(stdout.trim());
      log("1", `Entry tx: ${parsed.kaspa_tx_id} (status: ${parsed.status})`);
    } else {
      console.error("Entry tx failed:", stderr || err.message);
      throw new Error("IGRA entry failed");
    }
  }

  // Wait for iKAS to arrive
  log("1", "Waiting for iKAS on Igra (polling every 5s)...");
  const startTime = Date.now();
  while (true) {
    const current = await igraProvider.getBalance(addr);
    if (current > balanceBefore) {
      const received = current - balanceBefore;
      log("1", `iKAS arrived: +${ethers.formatEther(received)}`);
      break;
    }
    if (Date.now() - startTime > 300_000) throw new Error("Timeout waiting for iKAS (5 min)");
    process.stdout.write(".");
    await sleep(5_000);
  }
  console.log("");

  const iKasBalance = await igraProvider.getBalance(addr);
  log("1", `Total iKAS: ${ethers.formatEther(iKasBalance)}\n`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 2: Wrap iKAS -> WiKAS
  // ══════════════════════════════════════════════════════════════════

  const wikas = new ethers.Contract(WIKAS, WIKAS_ABI, igraWallet);

  // Keep 1 iKAS for gas (swap + approve + bridge = ~0.7 iKAS total)
  const gasReserve = ethers.parseEther("1");
  const wrapAmount = iKasBalance - gasReserve;

  if (wrapAmount <= 0n) {
    throw new Error("Not enough iKAS to wrap (need >1 iKAS after gas reserve)");
  }

  log("2", `Wrapping ${ethers.formatEther(wrapAmount)} iKAS -> WiKAS...`);
  const wrapTx = await wikas.deposit({ value: wrapAmount, gasPrice: GAS_PRICE, type: 0 });
  await wrapTx.wait();

  const wikasBalance = await wikas.balanceOf(addr);
  log("2", `WiKAS: ${ethers.formatEther(wikasBalance)}\n`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 3: Swap WiKAS -> USDC on ZealousSwap
  // ══════════════════════════════════════════════════════════════════

  // Get pool reserves
  const pool = new ethers.Contract(POOL, PAIR_ABI, igraProvider);
  const [r0, r1] = await pool.getReserves();
  // Pool: token0 = WiKAS (18 dec), token1 = USDC (6 dec)
  const expectedUsdc = getAmountOut(wikasBalance, r0, r1);
  const minOut = (expectedUsdc * 98n) / 100n; // 2% slippage
  log("3", `Pool: ${ethers.formatEther(r0)} WiKAS / ${ethers.formatUnits(r1, 6)} USDC`);
  log("3", `Expected USDC: ${ethers.formatUnits(expectedUsdc, 6)}`);
  log("3", `Min out (2% slip): ${ethers.formatUnits(minOut, 6)}`);

  // Approve WiKAS for router
  log("3", "Approving WiKAS...");
  await (await wikas.approve(ROUTER, wikasBalance, { gasPrice: GAS_PRICE, type: 0 })).wait();

  // Swap
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, igraWallet);
  const block = await igraProvider.getBlock("latest");
  const deadline = block.timestamp + 600;

  log("3", "Swapping WiKAS -> USDC...");
  const swapTx = await router.swapExactTokensForTokens(
    wikasBalance,
    minOut,
    [WIKAS, USDC_IGRA],
    addr,
    deadline,
    { gasPrice: GAS_PRICE, gasLimit: 300_000n, type: 0 }
  );
  const swapReceipt = await swapTx.wait();
  log("3", `Swap confirmed: ${swapReceipt.hash}`);

  const usdcContract = new ethers.Contract(USDC_IGRA, ERC20_ABI, igraProvider);
  const usdcBalance = await usdcContract.balanceOf(addr);
  log("3", `USDC on Igra: ${ethers.formatUnits(usdcBalance, 6)}\n`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 4: Hyperlane bridge USDC out to Base
  // ══════════════════════════════════════════════════════════════════

  // On Igra, USDC contract IS the warp route (same address)
  const usdcWarp = new ethers.Contract(USDC_IGRA, WARP_ABI, igraWallet);

  // Approve USDC for warp route (approve self — needed for transferRemote)
  log("4", "Approving USDC for Hyperlane bridge...");
  await (await usdcWarp.approve(USDC_IGRA, ethers.MaxUint256, { gasPrice: GAS_PRICE, type: 0 })).wait();

  // Quote gas payment (in iKAS)
  const gasPayment = await usdcWarp.quoteGasPayment(BASE_DOMAIN);
  log("4", `Hyperlane gas payment: ${ethers.formatEther(gasPayment)} iKAS`);

  const iKasLeft = await igraProvider.getBalance(addr);
  if (iKasLeft < gasPayment + 100_000n * GAS_PRICE) {
    throw new Error(`Insufficient iKAS for Hyperlane gas. Have ${ethers.formatEther(iKasLeft)}, need ~${ethers.formatEther(gasPayment)}`);
  }

  const recipient = ethers.zeroPadValue(addr, 32);
  log("4", `Bridging ${ethers.formatUnits(usdcBalance, 6)} USDC to Base...`);

  const bridgeTx = await usdcWarp.transferRemote(
    BASE_DOMAIN,
    recipient,
    usdcBalance,
    { value: gasPayment, gasPrice: GAS_PRICE, type: 0 }
  );
  const bridgeReceipt = await bridgeTx.wait();
  log("4", `Bridge tx confirmed: ${bridgeReceipt.hash}`);

  // Wait for USDC on Base
  log("4", "Waiting for USDC on Base (polling every 15s)...");
  const baseProvider = new ethers.JsonRpcProvider("https://mainnet.base.org");
  const usdcBase = new ethers.Contract(
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    ERC20_ABI,
    baseProvider
  );
  const baseUsdcBefore = await usdcBase.balanceOf(addr);

  while (true) {
    const baseUsdcNow = await usdcBase.balanceOf(addr);
    if (baseUsdcNow > baseUsdcBefore) {
      log("4", `USDC arrived on Base: ${ethers.formatUnits(baseUsdcNow, 6)}`);
      break;
    }
    if (Date.now() - startTime > 600_000) throw new Error("Timeout waiting for USDC on Base (10 min)");
    process.stdout.write(".");
    await sleep(15_000);
  }
  console.log("");

  console.log("\n=== Done ===");
  console.log(`Sold ${amountKas} KAS for USDC on Base`);
  console.log(`USDC received: ${ethers.formatUnits(await usdcBase.balanceOf(addr), 6)}`);
}

main().catch((err) => {
  console.error("\nERROR:", err.message || err);
  process.exit(1);
});
