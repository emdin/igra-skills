/**
 * Buy KAS with USDC (Base -> Igra -> KAS on Kaspa L1)
 *
 * Flow:
 *   1. Bridge USDC from Base to Igra via Hyperlane
 *   2. Swap USDC -> WiKAS on ZealousSwap
 *   3. Unwrap WiKAS -> iKAS
 *   4. Exit iKAS -> KAS via KasBridge lockForExit
 *   5. Wait for L1 release
 *
 * Usage: node buy-kas.js
 */

const { ethers } = require("ethers");
require("dotenv").config();

// ── Config ───────────────────────────────────────────────────────────

const BASE_RPC = "https://mainnet.base.org";
const IGRA_RPC = "https://rpc.igralabs.com:8545";
const IGRA_DOMAIN = 38833;
const GAS_PRICE_IGRA = 1_100_000_000_000n; // 1100 gwei

// Base
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WARP_ROUTE_BASE = "0x84e1dF3553B16452AeD7060A4266E4E434f418cC";

// Igra
const USDC_IGRA = "0xA5b8BF902b2844dA17d4506cc827F7F1681735E7";
const ROUTER = "0xA5B0946D31aD2d251e0fe2dfEA8808BFd475e607";
const WIKAS = "0x17Ec7E1768c813E2a3a9b0f94A35605CA520C242";
const POOL = "0x7826f5421c324590b1c21d22231c48ad059cbe45";
const KASBRIDGE = "0xb82c5524c5b5c055efb2F8f4AbCcE3173c504f2d";

// Kaspa destination (from generate-wallet.js derivation)
// Set this to the user's Kaspa delivery address
const KASPA_ADDRESS = process.env.KASPA_ADDRESS || "kaspa:qr...your-address...";

// ── ABIs ─────────────────────────────────────────────────────────────

const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
];

const WARP_ABI = [
  "function transferRemote(uint32 destination, bytes32 recipient, uint256 amount) payable returns (bytes32)",
  "function quoteGasPayment(uint32 destination) view returns (uint256)",
];

const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)",
];

const PAIR_ABI = [
  "function getReserves() view returns (uint112, uint112, uint32)",
];

const WIKAS_ABI = [
  "function withdraw(uint256 amount)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const KASBRIDGE_ABI = [
  "function lockForExit(bytes kaspaAddress) payable",
  "function exits(uint256 exitId) view returns (address sender, uint256 grossAmount, uint256 fee, uint256 netAmount, bytes kaspaAddress, uint256 blockNumber, bool acknowledged, bool processed, bool refunded, bytes32 kaspaTxHash)",
  "function exitCounter() view returns (uint256)",
  "function getCurrentFee(uint256 amount) view returns (uint256)",
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

  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const igraProvider = new ethers.JsonRpcProvider(IGRA_RPC);
  const baseWallet = new ethers.Wallet(key, baseProvider);
  const igraWallet = new ethers.Wallet(key, igraProvider);
  const addr = baseWallet.address;

  console.log("=== Buy KAS with USDC ===");
  console.log(`Wallet: ${addr}`);
  console.log(`Kaspa destination: ${KASPA_ADDRESS}\n`);

  // ── Check starting balances ──
  const usdcBase = new ethers.Contract(USDC_BASE, ERC20_ABI, baseWallet);
  const usdcBalance = await usdcBase.balanceOf(addr);
  const ethBalance = await baseProvider.getBalance(addr);
  log("0", `Base USDC: ${ethers.formatUnits(usdcBalance, 6)}`);
  log("0", `Base ETH:  ${ethers.formatEther(ethBalance)}`);

  if (usdcBalance === 0n) throw new Error("No USDC on Base");

  const amount = usdcBalance; // use full balance
  log("0", `Bridging ${ethers.formatUnits(amount, 6)} USDC to Igra\n`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 1: Bridge USDC from Base to Igra via Hyperlane
  // ══════════════════════════════════════════════════════════════════

  log("1", "Approving USDC for Hyperlane warp route...");
  const approveTx = await usdcBase.approve(WARP_ROUTE_BASE, amount);
  await approveTx.wait();
  log("1", "Approved");

  const warpRoute = new ethers.Contract(WARP_ROUTE_BASE, WARP_ABI, baseWallet);
  const gasPayment = await warpRoute.quoteGasPayment(IGRA_DOMAIN);
  log("1", `Gas payment: ${ethers.formatEther(gasPayment)} ETH`);

  if (ethBalance < gasPayment + 50_000n * 100_000n) {
    throw new Error(`Insufficient ETH for gas. Need ~${ethers.formatEther(gasPayment)} ETH for Hyperlane + tx gas`);
  }

  const recipient = ethers.zeroPadValue(addr, 32);
  log("1", "Submitting transferRemote...");
  const bridgeTx = await warpRoute.transferRemote(IGRA_DOMAIN, recipient, amount, {
    value: gasPayment,
  });
  const bridgeReceipt = await bridgeTx.wait();
  log("1", `Bridge tx confirmed: ${bridgeReceipt.hash}`);

  // Wait for USDC to arrive on Igra
  log("1", "Waiting for USDC on Igra (polling every 10s)...");
  const usdcIgra = new ethers.Contract(USDC_IGRA, ERC20_ABI, igraProvider);
  let igraUsdcBalance = 0n;
  const startTime = Date.now();
  while (true) {
    igraUsdcBalance = await usdcIgra.balanceOf(addr);
    if (igraUsdcBalance >= amount) break;
    if (Date.now() - startTime > 600_000) throw new Error("Timeout waiting for USDC on Igra (10min)");
    process.stdout.write(".");
    await sleep(10_000);
  }
  console.log("");
  log("1", `USDC arrived on Igra: ${ethers.formatUnits(igraUsdcBalance, 6)}\n`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 2: Swap USDC -> WiKAS on ZealousSwap
  // ══════════════════════════════════════════════════════════════════

  // Check we have iKAS for gas on Igra
  const igraBalance = await igraProvider.getBalance(addr);
  log("2", `Igra iKAS balance: ${ethers.formatEther(igraBalance)}`);
  if (igraBalance === 0n) {
    log("2", "WARNING: No iKAS for gas on Igra. Get some from faucet: https://faucet.igralabs.com");
    log("2", `Address: ${addr}`);
    log("2", "Waiting for iKAS (polling every 10s)...");
    while (true) {
      const bal = await igraProvider.getBalance(addr);
      if (bal > 0n) {
        log("2", `Got iKAS: ${ethers.formatEther(bal)}`);
        break;
      }
      if (Date.now() - startTime > 1200_000) throw new Error("Timeout waiting for iKAS gas");
      process.stdout.write(".");
      await sleep(10_000);
    }
    console.log("");
  }

  // Calculate swap output from reserves
  const pool = new ethers.Contract(POOL, PAIR_ABI, igraProvider);
  const [reserve0, reserve1] = await pool.getReserves();
  // Pool: token0 = WiKAS (18 dec), token1 = USDC (6 dec)
  const expectedWikas = getAmountOut(igraUsdcBalance, reserve1, reserve0);
  const amountOutMin = (expectedWikas * 98n) / 100n; // 2% slippage
  log("2", `Pool reserves: ${ethers.formatEther(reserve0)} WiKAS / ${ethers.formatUnits(reserve1, 6)} USDC`);
  log("2", `Expected WiKAS: ${ethers.formatEther(expectedWikas)}`);
  log("2", `Min WiKAS (2% slip): ${ethers.formatEther(amountOutMin)}`);

  // Approve USDC for router
  const usdcIgraContract = new ethers.Contract(USDC_IGRA, ERC20_ABI, igraWallet);
  log("2", "Approving USDC for ZealousSwap...");
  await (await usdcIgraContract.approve(ROUTER, igraUsdcBalance, { gasPrice: GAS_PRICE_IGRA })).wait();

  // Swap
  const block = await igraProvider.getBlock("latest");
  const deadline = block.timestamp + 600;
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, igraWallet);

  log("2", "Swapping USDC -> WiKAS...");
  const swapTx = await router.swapExactTokensForTokens(
    igraUsdcBalance,
    amountOutMin,
    [USDC_IGRA, WIKAS],
    addr,
    deadline,
    { gasPrice: GAS_PRICE_IGRA, gasLimit: 300_000 }
  );
  const swapReceipt = await swapTx.wait();
  log("2", `Swap confirmed: ${swapReceipt.hash}`);

  const wikas = new ethers.Contract(WIKAS, WIKAS_ABI, igraWallet);
  const wikasBalance = await wikas.balanceOf(addr);
  log("2", `WiKAS balance: ${ethers.formatEther(wikasBalance)}\n`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 3: Unwrap WiKAS -> iKAS
  // ══════════════════════════════════════════════════════════════════

  log("3", "Unwrapping WiKAS -> iKAS...");
  const unwrapTx = await wikas.withdraw(wikasBalance, { gasPrice: GAS_PRICE_IGRA });
  await unwrapTx.wait();

  const iKasAfterUnwrap = await igraProvider.getBalance(addr);
  log("3", `iKAS balance: ${ethers.formatEther(iKasAfterUnwrap)}\n`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 4: Lock iKAS for exit via KasBridge
  // ══════════════════════════════════════════════════════════════════

  const kasBridge = new ethers.Contract(KASBRIDGE, KASBRIDGE_ABI, igraWallet);

  // Reserve iKAS for gas. lockForExit uses ~280k gas = 0.31 iKAS at 1100 gwei.
  // msg.value + gasLimit*gasPrice must be <= balance (checked before execution).
  const gasLimit = 350_000n;
  const gasCost = gasLimit * GAS_PRICE_IGRA;
  let exitAmount = iKasAfterUnwrap - gasCost;

  // Check minimum: KasBridge min is 10 iKAS (after fee)
  // Fee is 0.1% with 10 iKAS floor
  const fee = await kasBridge.getCurrentFee(exitAmount);
  const netAfterFee = exitAmount - fee;
  log("4", `Exit amount: ${ethers.formatEther(exitAmount)} iKAS`);
  log("4", `Fee: ${ethers.formatEther(fee)} iKAS`);
  log("4", `Net after fee: ${ethers.formatEther(netAfterFee)} iKAS`);

  if (netAfterFee < ethers.parseEther("10")) {
    log("4", `Net amount ${ethers.formatEther(netAfterFee)} iKAS is below KasBridge minimum (10 iKAS).`);
    log("4", "Cannot exit via KasBridge. iKAS stays on Igra.");
    log("4", `Your iKAS balance on Igra: ${ethers.formatEther(iKasAfterUnwrap)}`);
    console.log("\n=== Done (partial) ===");
    console.log("USDC was bridged and swapped to iKAS on Igra.");
    console.log("Amount too small for KasBridge exit (min 10 iKAS net).");
    console.log(`iKAS on Igra: ${ethers.formatEther(iKasAfterUnwrap)}`);
    return;
  }

  const exitCounterBefore = await kasBridge.exitCounter();
  log("4", `Locking iKAS for exit to ${KASPA_ADDRESS}...`);

  const lockTx = await kasBridge.lockForExit(
    ethers.toUtf8Bytes(KASPA_ADDRESS),
    { value: exitAmount, gasPrice: GAS_PRICE_IGRA, gasLimit: gasLimit, type: 0 }
  );
  const lockReceipt = await lockTx.wait();
  const exitId = exitCounterBefore;
  log("4", `Lock confirmed: ${lockReceipt.hash}`);
  log("4", `Exit ID: ${exitId}\n`);

  // ══════════════════════════════════════════════════════════════════
  // STEP 5: Wait for L1 release
  // ══════════════════════════════════════════════════════════════════

  log("5", "Waiting for KAS release on Kaspa L1 (polling every 30s)...");
  while (true) {
    const exit = await kasBridge.exits(exitId);
    if (exit.processed && exit.kaspaTxHash !== ethers.ZeroHash) {
      log("5", `KAS released on L1!`);
      log("5", `Kaspa TX: ${exit.kaspaTxHash}`);
      break;
    }
    if (exit.acknowledged) {
      log("5", "Exit acknowledged by relayers, FROST signing in progress...");
    }
    await sleep(30_000);
  }

  console.log("\n=== Done ===");
  console.log(`Bought KAS with ${ethers.formatUnits(amount, 6)} USDC`);
  console.log(`KAS delivered to: ${KASPA_ADDRESS}`);
}

main().catch((err) => {
  console.error("\nERROR:", err.message || err);
  process.exit(1);
});
