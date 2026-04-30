/**
 * KAS ↔ USDC Self-Bootstrapping Round-Trip
 *
 * Phase 1: SELL — KAS (L1) → USDC (Base)
 *   1a. Bootstrap iKAS gas via IGRA native entry (free)
 *   1b. Wrap + swap + bridge to Base
 *
 * Phase 2: GET GAS — Swap tiny USDC→ETH on Base (Uniswap)
 *
 * Phase 3: BUY — USDC (Base) → KAS (L1)
 *   3a. Bridge USDC to Igra via Hyperlane
 *   3b. Swap + unwrap + lockForExit
 *   3c. Wait for L1 release
 *
 * Usage: node swap-roundtrip.js <kas_amount>
 *   e.g. node swap-roundtrip.js 50
 */

const { ethers } = require("ethers");
const { execSync } = require("child_process");
require("dotenv").config();

// ── Config ───────────────────────────────────────────────────────────

const IGRA_RPC = "https://rpc.igralabs.com:8545";
const BASE_RPC = "https://mainnet.base.org";
const GP = 1_100_000_000_000n;
const ENTRY_BIN = "/Users/emdin/Projects/igra/tmp/igra-foundry/target/release/igra_entry_tx";

const C = {
  USDC_BASE: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH_BASE: "0x4200000000000000000000000000000000000006",
  UNISWAP_ROUTER: "0x2626664c2603336E57B271c5C0b26F421741e481",
  WARP_BASE: "0x84e1dF3553B16452AeD7060A4266E4E434f418cC",
  USDC_IGRA: "0xA5b8BF902b2844dA17d4506cc827F7F1681735E7",
  ROUTER: "0xA5B0946D31aD2d251e0fe2dfEA8808BFd475e607",
  WIKAS: "0x17Ec7E1768c813E2a3a9b0f94A35605CA520C242",
  POOL: "0x7826f5421c324590b1c21d22231c48ad059cbe45",
  KASBRIDGE: "0xb82c5524c5b5c055efb2F8f4AbCcE3173c504f2d",
};

// Set this to the user's Kaspa delivery address
const KASPA_ADDR = process.env.KASPA_ADDRESS || "kaspa:qr...your-address...";

const ABI = {
  erc20: ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
  warp: ["function transferRemote(uint32,bytes32,uint256) payable returns (bytes32)", "function quoteGasPayment(uint32) view returns (uint256)"],
  router: ["function swapExactTokensForTokens(uint,uint,address[],address,uint) returns (uint[])"],
  pair: ["function getReserves() view returns (uint112,uint112,uint32)"],
  wikas: ["function deposit() payable", "function withdraw(uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"],
  bridge: ["function lockForExit(bytes) payable", "function exits(uint256) view returns (address,uint256,uint256,uint256,bytes,uint256,bool,bool,bool,bytes32)", "function exitCounter() view returns (uint256)", "function getCurrentFee(uint256) view returns (uint256)"],
};

// ── Display ──────────────────────────────────────────────────────────

const DIM = "\x1b[2m", RESET = "\x1b[0m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m", CYAN = "\x1b[36m", BOLD = "\x1b[1m";
let phaseStart, globalStart;

function el() { return ((Date.now() - phaseStart) / 1000).toFixed(1); }
function total() { return ((Date.now() - globalStart) / 1000).toFixed(1); }

function status(step, tot, label, detail) {
  const bar = Array.from({ length: tot }, (_, i) => i < step ? "█" : "░").join("");
  process.stdout.write(`\r  ${CYAN}${bar}${RESET} ${DIM}${label}${RESET}  ${detail || ""}          `);
}

function done(step, tot, label, detail) {
  const bar = Array.from({ length: tot }, (_, i) => i < step ? "█" : "░").join("");
  console.log(`\r  ${GREEN}${bar}${RESET} ${GREEN}${label}${RESET}  ${detail || ""}          `);
}

function header(text) {
  console.log(`\n${BOLD}${CYAN}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}  ${text}${RESET}`);
  console.log(`${CYAN}${"═".repeat(60)}${RESET}\n`);
}

function info(label, value) { console.log(`  ${DIM}${label}:${RESET} ${value}`); }
function amtOut(a, rIn, rOut) { const f = a * 997n; return (f * rOut) / (rIn * 1000n + f); }

// ── Phase 1: SELL ────────────────────────────────────────────────────

async function sell(amountKas) {
  header(`PHASE 1: SELL ${amountKas} KAS → USDC on Base`);
  phaseStart = Date.now();
  const igra = new ethers.JsonRpcProvider(IGRA_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, igra);
  const addr = wallet.address;
  const key = process.env.PRIVATE_KEY.replace("0x", "");
  const S = 8; // steps

  // 1: Bootstrap iKAS via entry
  const ikBefore = await igra.getBalance(addr);
  if (ikBefore < ethers.parseEther("1.5")) {
    status(0, S, "Bootstrapping iKAS via IGRA entry (free)...");
    const extraKas = 10; // minimum entry
    try {
      const out = execSync(`${ENTRY_BIN} --preset mainnet --private-key ${key} --recipient ${addr} --amount ${amountKas + extraKas}`,
        { encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      const stdout = err.stdout?.toString() || "";
      if (!stdout.includes("kaspa_tx_id")) throw new Error("Entry failed: " + (err.stderr?.toString().split("\n")[0] || err.message));
    }
    done(1, S, "Entry submitted", `${amountKas + extraKas} KAS (${el()}s)`);

    status(1, S, "Waiting for iKAS on Igra...");
    while (true) {
      const cur = await igra.getBalance(addr);
      if (cur > ikBefore) { done(2, S, "iKAS arrived", `+${ethers.formatEther(cur - ikBefore)} iKAS (${el()}s)`); break; }
      await new Promise(r => setTimeout(r, 3000));
    }
  } else {
    // Already have iKAS, just do the entry for the swap amount
    status(0, S, "Submitting IGRA entry...");
    try {
      execSync(`${ENTRY_BIN} --preset mainnet --private-key ${key} --recipient ${addr} --amount ${amountKas}`,
        { encoding: "utf-8", timeout: 60_000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      if (!(err.stdout?.toString() || "").includes("kaspa_tx_id")) throw new Error("Entry failed");
    }
    done(1, S, "Entry submitted", `${amountKas} KAS (${el()}s)`);

    status(1, S, "Waiting for iKAS...");
    const before = await igra.getBalance(addr);
    while (true) {
      const cur = await igra.getBalance(addr);
      if (cur > before) { done(2, S, "iKAS arrived", `+${ethers.formatEther(cur - before)} iKAS (${el()}s)`); break; }
      await new Promise(r => setTimeout(r, 3000));
    }
  }

  // 3: Wrap
  const ikTotal = await igra.getBalance(addr);
  const gasReserve = ethers.parseEther("1.5");
  const wrapAmt = ikTotal - gasReserve;
  status(2, S, "Wrapping iKAS → WiKAS...");
  const wikas = new ethers.Contract(C.WIKAS, ABI.wikas, wallet);
  await (await wikas.deposit({ value: wrapAmt, gasPrice: GP, type: 0 })).wait();
  const wBal = await wikas.balanceOf(addr);
  done(3, S, "Wrapped", `${ethers.formatEther(wBal).slice(0, 8)} WiKAS (${el()}s)`);

  // 4: Swap WiKAS → USDC
  status(3, S, "Swapping WiKAS → USDC...");
  const [r0, r1] = await new ethers.Contract(C.POOL, ABI.pair, igra).getReserves();
  await (await wikas.approve(C.ROUTER, wBal, { gasPrice: GP, type: 0 })).wait();
  const blk = await igra.getBlock("latest");
  await (await new ethers.Contract(C.ROUTER, ABI.router, wallet).swapExactTokensForTokens(
    wBal, (amtOut(wBal, r0, r1) * 97n) / 100n, [C.WIKAS, C.USDC_IGRA], addr, blk.timestamp + 600,
    { gasPrice: GP, gasLimit: 300_000n, type: 0 }
  )).wait();
  const usdcBal = await new ethers.Contract(C.USDC_IGRA, ABI.erc20, igra).balanceOf(addr);
  done(4, S, "Swapped", `${ethers.formatUnits(usdcBal, 6)} USDC (${el()}s)`);

  // 5: Approve USDC
  status(4, S, "Approving USDC for bridge...");
  const usdcWarp = new ethers.Contract(C.USDC_IGRA, [...ABI.erc20, ...ABI.warp], wallet);
  await (await usdcWarp.approve(C.USDC_IGRA, ethers.MaxUint256, { gasPrice: GP, type: 0 })).wait();
  done(5, S, "Approved", `(${el()}s)`);

  // 6: Bridge
  status(5, S, "Bridging USDC to Base...");
  const gasPayment = await usdcWarp.quoteGasPayment(8453);
  const bridgeAmt = usdcBal * 999n / 1000n;
  await (await usdcWarp.transferRemote(8453, ethers.zeroPadValue(addr, 32), bridgeAmt,
    { value: gasPayment, gasPrice: GP, gasLimit: 350_000n, type: 0 }
  )).wait();
  done(6, S, "Bridge tx confirmed", `${ethers.formatUnits(bridgeAmt, 6)} USDC (${el()}s)`);

  // 7: Wait for Base
  status(6, S, "Waiting for USDC on Base...");
  const base = new ethers.JsonRpcProvider(BASE_RPC);
  const usdcBase = new ethers.Contract(C.USDC_BASE, ABI.erc20, base);
  const baseBefore = await usdcBase.balanceOf(addr);
  while (true) {
    const now = await usdcBase.balanceOf(addr);
    if (now > baseBefore) {
      done(7, S, "USDC on Base!", `+${ethers.formatUnits(now - baseBefore, 6)} USDC (${el()}s)`);
      return { usdc: now - baseBefore, time: el() };
    }
    await new Promise(r => setTimeout(r, 10000));
  }
}

// ── Phase 2: GET ETH GAS on Base ─────────────────────────────────────

async function getBaseGas() {
  header("PHASE 2: Swap USDC → ETH on Base (for Hyperlane gas)");
  phaseStart = Date.now();
  const base = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, base);
  const addr = wallet.address;
  const S = 2;

  const ethBal = await base.getBalance(addr);
  const warpQuote = await new ethers.Contract(C.WARP_BASE, ABI.warp, base).quoteGasPayment(38833);
  const needed = warpQuote + 500_000n * 100_000n; // Hyperlane gas + tx overhead

  if (ethBal >= needed) {
    done(2, S, "Already have enough ETH", `${ethers.formatEther(ethBal)} ETH (${el()}s)`);
    return;
  }

  // Swap 0.50 USDC → ETH on Uniswap V3 (SwapRouter02)
  const swapAmount = 500_000n; // 0.50 USDC
  status(0, S, "Approving USDC for Uniswap...");
  const usdc = new ethers.Contract(C.USDC_BASE, ABI.erc20, wallet);
  await (await new ethers.Contract(C.USDC_BASE,
    ["function approve(address,uint256) returns (bool)"], wallet)
    .approve(C.UNISWAP_ROUTER, swapAmount)).wait();
  done(1, S, "Approved", `(${el()}s)`);

  // exactInputSingle: USDC → WETH, fee 500 (0.05%)
  status(1, S, "Swapping 0.50 USDC → ETH on Uniswap...");
  const swapRouter = new ethers.Contract(C.UNISWAP_ROUTER, [
    "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256)",
  ], wallet);

  const tx = await swapRouter.exactInputSingle({
    tokenIn: C.USDC_BASE,
    tokenOut: C.WETH_BASE,
    fee: 500,
    recipient: addr,
    amountIn: swapAmount,
    amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  });
  await tx.wait();

  // Unwrap WETH → ETH (must wait for swap to settle first)
  await new Promise(r => setTimeout(r, 2000));
  const weth = new ethers.Contract(C.WETH_BASE, ["function withdraw(uint256)", "function balanceOf(address) view returns (uint256)"], wallet);
  const wethBal = await weth.balanceOf(addr);
  if (wethBal > 0n) {
    await (await weth.withdraw(wethBal)).wait();
  }

  const newEth = await base.getBalance(addr);
  done(2, S, "Got ETH", `${ethers.formatEther(newEth)} ETH (${el()}s)`);
}

// ── Phase 3: BUY ─────────────────────────────────────────────────────

async function buy() {
  const base = new ethers.JsonRpcProvider(BASE_RPC);
  const igra = new ethers.JsonRpcProvider(IGRA_RPC);
  const baseW = new ethers.Wallet(process.env.PRIVATE_KEY, base);
  const igraW = new ethers.Wallet(process.env.PRIVATE_KEY, igra);
  const addr = baseW.address;

  const usdcBase = new ethers.Contract(C.USDC_BASE, ABI.erc20, base);
  const amount = await usdcBase.balanceOf(addr);

  header(`PHASE 3: BUY KAS with ${ethers.formatUnits(amount, 6)} USDC`);
  phaseStart = Date.now();
  const S = 8;

  // 1: Bridge USDC → Igra
  status(0, S, "Bridging USDC to Igra...");
  const warp = new ethers.Contract(C.WARP_BASE, ABI.warp, baseW);
  const gasP = await warp.quoteGasPayment(38833);
  await (await warp.transferRemote(38833, ethers.zeroPadValue(addr, 32), amount, { value: gasP })).wait();
  done(1, S, "Bridge tx confirmed", `(${el()}s)`);

  // 2: Wait for USDC on Igra
  status(1, S, "Waiting for USDC on Igra...");
  const usdcIgra = new ethers.Contract(C.USDC_IGRA, ABI.erc20, igra);
  const ub = await usdcIgra.balanceOf(addr);
  while (true) {
    const b = await usdcIgra.balanceOf(addr);
    if (b > ub) { done(2, S, "USDC on Igra", `${ethers.formatUnits(b, 6)} (${el()}s)`); break; }
    await new Promise(r => setTimeout(r, 5000));
  }

  // 3: Swap USDC → WiKAS
  status(2, S, "Swapping USDC → WiKAS...");
  const igraUsdc = await usdcIgra.balanceOf(addr);
  await (await new ethers.Contract(C.USDC_IGRA, ABI.erc20, igraW).approve(C.ROUTER, igraUsdc, { gasPrice: GP, type: 0 })).wait();
  const [r0, r1] = await new ethers.Contract(C.POOL, ABI.pair, igra).getReserves();
  const blk = await igra.getBlock("latest");
  await (await new ethers.Contract(C.ROUTER, ABI.router, igraW).swapExactTokensForTokens(
    igraUsdc, 0n, [C.USDC_IGRA, C.WIKAS], addr, blk.timestamp + 600,
    { gasPrice: GP, gasLimit: 300_000n, type: 0 }
  )).wait();
  const wBal = await new ethers.Contract(C.WIKAS, ABI.wikas, igra).balanceOf(addr);
  done(3, S, "Swapped", `${ethers.formatEther(wBal).slice(0, 8)} WiKAS (${el()}s)`);

  // 4: Unwrap WiKAS → iKAS
  status(3, S, "Unwrapping WiKAS → iKAS...");
  await (await new ethers.Contract(C.WIKAS, ABI.wikas, igraW).withdraw(wBal, { gasPrice: GP, type: 0 })).wait();
  const ikBal = await igra.getBalance(addr);
  done(4, S, "Unwrapped", `${ethers.formatEther(ikBal).slice(0, 8)} iKAS (${el()}s)`);

  // 5: lockForExit
  status(4, S, "Locking iKAS for exit...");
  const kb = new ethers.Contract(C.KASBRIDGE, ABI.bridge, igraW);
  const gasLim = 350_000n;
  const exitAmt = ikBal - gasLim * GP;
  const fee = await kb.getCurrentFee(exitAmt);
  const net = exitAmt - fee;

  if (net < ethers.parseEther("10")) {
    done(5, S, "Below minimum", `${ethers.formatEther(net).slice(0, 8)} net < 10 iKAS`);
    console.log(`\n  ${YELLOW}Not enough for KasBridge exit (10 iKAS min after ${ethers.formatEther(fee)} fee).${RESET}`);
    console.log(`  ${YELLOW}iKAS stays on Igra: ${ethers.formatEther(ikBal)}${RESET}`);
    return { kas: 0n, time: el() };
  }

  const ctr = await kb.exitCounter();
  await (await kb.lockForExit(ethers.toUtf8Bytes(KASPA_ADDR),
    { value: exitAmt, gasPrice: GP, gasLimit: gasLim, type: 0 }
  )).wait();
  done(5, S, "Locked", `Exit #${ctr} | net: ${ethers.formatEther(net).slice(0, 8)} KAS | fee: ${ethers.formatEther(fee)} (${el()}s)`);

  // 6-8: Wait for L1 release
  let acked = false;
  status(5, S, "Waiting for relayer acknowledgment...");
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 30000));
    const e = await kb.exits(ctr);
    if (e[7] && e[9] !== ethers.ZeroHash) {
      if (!acked) done(6, S, "Acknowledged", `(${el()}s)`);
      done(7, S, "FROST signed", `(${el()}s)`);
      done(8, S, "KAS released!", `${ethers.formatEther(e[3]).slice(0, 8)} KAS (${el()}s)`);
      return { kas: e[3], kaspaTx: e[9], time: el() };
    }
    if (e[6] && !acked) {
      done(6, S, "Acknowledged", `(${el()}s)`);
      status(6, S, "FROST threshold signing...");
      acked = true;
    }
  }
  console.log(`\n  ${YELLOW}Not released after 20 min. Exit #${ctr}${RESET}`);
  return { kas: 0n, exitId: ctr, time: el() };
}

// ── MAIN ─────────────────────────────────────────────────────────────

async function main() {
  const kasAmount = parseFloat(process.argv[2] || "0");
  if (kasAmount <= 0) {
    console.log("Usage: node swap-roundtrip.js <kas_amount>");
    console.log("  e.g. node swap-roundtrip.js 50");
    process.exit(1);
  }

  const addr = new ethers.Wallet(process.env.PRIVATE_KEY).address;
  console.log(`\n${BOLD}  KAS ↔ USDC Self-Bootstrapping Round-Trip${RESET}`);
  console.log(`  ${DIM}Wallet: ${addr}${RESET}`);
  console.log(`  ${DIM}Kaspa:  ${KASPA_ADDR}${RESET}`);
  globalStart = Date.now();

  // Phase 1: Sell KAS → USDC on Base
  const sellResult = await sell(kasAmount);

  // Phase 2: Get ETH gas on Base (swap tiny USDC→ETH)
  await getBaseGas();

  console.log(`\n  ${DIM}${"─".repeat(56)}${RESET}`);

  // Phase 3: Buy KAS with remaining USDC
  const buyResult = await buy();

  // Summary
  header("ROUND-TRIP SUMMARY");
  info("Sell", `${kasAmount} KAS → ${ethers.formatUnits(sellResult.usdc, 6)} USDC on Base (${sellResult.time}s)`);
  if (buyResult.kas > 0n) {
    info("Buy", `USDC → ${ethers.formatEther(buyResult.kas).slice(0, 8)} KAS on L1 (${buyResult.time}s)`);
    const loss = (1 - Number(ethers.formatEther(buyResult.kas)) / kasAmount) * 100;
    info("Round-trip loss", `${kasAmount} KAS in → ${ethers.formatEther(buyResult.kas).slice(0, 8)} KAS out (${loss.toFixed(1)}%)`);
  } else if (buyResult.exitId) {
    info("Buy", `Locked, exit #${buyResult.exitId} pending release`);
  } else {
    info("Buy", `Below KasBridge minimum — iKAS stays on Igra`);
  }
  info("Total time", `${total()}s`);
}

main().catch(e => {
  console.error(`\n  ${"\x1b[31m"}ERROR: ${e.shortMessage || e.message}${RESET}`);
  process.exit(1);
});
