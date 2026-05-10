/**
 * Gasless Buy KAS: USDC → KAS via ERC-4337 smart account + USDC paymaster
 *
 * User needs: USDC on Igra (bridged via Hyperlane). Zero iKAS needed.
 * All gas paid in USDC via paymaster 0xe643D56C...6CF7.
 *
 * Flow:
 *   UserOp 1: create smart account + approve paymaster + approve router + swap USDC→WiKAS
 *   UserOp 2: unwrap WiKAS→iKAS
 *   UserOp 3: lockForExit to Kaspa L1
 *
 * Usage: USDC_AMOUNT=3 KASPA_ADDRESS=kaspa:qr... node buy-kas-gasless.js
 */

const { ethers } = require("ethers");
require("dotenv").config();

// ── Config ───────────────────────────────────────────────────────────

const IGRA_RPC = "https://rpc.igralabs.com:8545";
const BUNDLER_RPC = "https://bubundler.jobberwocky.co";

const EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const FACTORY = "0x13E9ed32155810FDbd067D4522C492D6f68E5944";
const PAYMASTER = "0xe643D56CBd46b557b11753C6cA579a0da6486CF7";

const USDC = "0xA5b8BF902b2844dA17d4506cc827F7F1681735E7";
const WIKAS = "0x17Ec7E1768c813E2a3a9b0f94A35605CA520C242";
const ROUTER = "0xA5B0946D31aD2d251e0fe2dfEA8808BFd475e607";
const POOL = "0x7826f5421c324590b1c21d22231c48ad059cbe45";
const KASBRIDGE = "0xb82c5524c5b5c055efb2F8f4AbCcE3173c504f2d";

const KASPA_ADDRESS = process.env.KASPA_ADDRESS;

// ── ABIs ─────────────────────────────────────────────────────────────

const ERC20 = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const PAIR = ["function getReserves() view returns (uint112,uint112,uint32)"];
const KASBRIDGE_ABI = [
  "function lockForExit(bytes kaspaAddress) payable",
  "function exits(uint256) view returns (address,uint256,uint256,uint256,bytes,uint256,bool,bool,bool,bytes32)",
  "function exitCounter() view returns (uint256)",
];

// ── Bundler RPC ──────────────────────────────────────────────────────

async function rpc(method, params) {
  const r = await fetch(BUNDLER_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`${method}: ${JSON.stringify(d.error)}`);
  return d.result;
}

// ── Encode executeBatch ──────────────────────────────────────────────

function batch(calls) {
  return new ethers.Interface([
    "function executeBatch((address target, uint256 value, bytes data)[] calls)",
  ]).encodeFunctionData("executeBatch", [calls]);
}

function encode(abi, fn, args) {
  return new ethers.Interface(abi).encodeFunctionData(fn, args);
}

// ── AMM output ───────────────────────────────────────────────────────

function getAmountOut(amountIn, reserveIn, reserveOut) {
  const f = amountIn * 997n;
  return (f * reserveOut) / (reserveIn * 1000n + f);
}

// ── Send UserOperation ──────────────────────────────────────────────

async function sendUserOp(provider, wallet, smartAccount, callData, isFirst) {
  const nonce = await new ethers.Contract(EP,
    ["function getNonce(address,uint192) view returns (uint256)"], provider)
    .getNonce(smartAccount, 0);

  // Valid dummy signature for estimation
  const dummySig = ethers.Signature.from(
    wallet.signingKey.sign(ethers.keccak256("0x00"))
  ).serialized;

  const op = {
    sender: smartAccount.toLowerCase(),
    nonce: ethers.toBeHex(nonce),
    callData,
    callGasLimit: "0xF4240",           // 1M — high for estimation
    verificationGasLimit: "0x7A120",   // 500k — high for estimation
    preVerificationGas: "0x186A0",     // 100k
    maxFeePerGas: "0xe8d4a51000",      // 1000 gwei
    maxPriorityFeePerGas: "0xe8d4a51000",
    signature: dummySig,
  };

  // First UserOp: deploy smart account via factory
  if (isFirst) {
    op.factory = FACTORY.toLowerCase();
    op.factoryData = encode(
      ["function createAccount(address,uint256) returns (address)"],
      "createAccount", [wallet.address, 0n]
    );
  }

  // 1. Get paymaster sponsorship (guarantor mode)
  const sponsor1 = await rpc("pm_sponsorUserOperation", [op, EP]);
  op.paymaster = sponsor1.paymaster;
  op.paymasterData = sponsor1.paymasterData;
  op.paymasterVerificationGasLimit = sponsor1.paymasterVerificationGasLimit;
  op.paymasterPostOpGasLimit = sponsor1.paymasterPostOpGasLimit;

  // 2. Estimate gas
  const gas = await rpc("eth_estimateUserOperationGas", [op, EP]);
  op.callGasLimit = gas.callGasLimit;
  op.verificationGasLimit = gas.verificationGasLimit;
  op.preVerificationGas = gas.preVerificationGas;
  if (gas.paymasterVerificationGasLimit) op.paymasterVerificationGasLimit = gas.paymasterVerificationGasLimit;
  if (gas.paymasterPostOpGasLimit) op.paymasterPostOpGasLimit = gas.paymasterPostOpGasLimit;

  // 3. Re-sponsor (gas values changed → guarantor sig invalidated)
  const sponsor2 = await rpc("pm_sponsorUserOperation", [op, EP]);
  op.paymasterData = sponsor2.paymasterData;

  // 4. Hash + sign (raw ECDSA — NOT signMessage / EIP-191)
  const initCode = isFirst
    ? FACTORY.toLowerCase() + op.factoryData.slice(2)
    : "0x";

  const pmV = BigInt(op.paymasterVerificationGasLimit).toString(16).padStart(32, "0");
  const pmP = BigInt(op.paymasterPostOpGasLimit).toString(16).padStart(32, "0");
  const pmAndData = op.paymaster.toLowerCase() + pmV + pmP + op.paymasterData.slice(2);

  function pack32(a, b) {
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
    accountGasLimits: pack32(op.verificationGasLimit, op.callGasLimit),
    preVerificationGas: BigInt(op.preVerificationGas),
    gasFees: pack32(op.maxPriorityFeePerGas, op.maxFeePerGas),
    paymasterAndData: pmAndData, signature: "0x",
  });
  op.signature = ethers.Signature.from(wallet.signingKey.sign(hash)).serialized;

  // 5. Submit
  const opHash = await rpc("eth_sendUserOperation", [op, EP]);
  console.log(`  UserOp submitted: ${opHash}`);

  // 6. Wait for receipt (1s intervals, 15s timeout)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const receipt = await rpc("eth_getUserOperationReceipt", [opHash]);
      if (receipt) {
        if (!receipt.success) throw new Error(`UserOp reverted. tx: ${receipt.receipt?.transactionHash}`);
        console.log(`  Mined in tx: ${receipt.receipt?.transactionHash}`);
        return receipt;
      }
    } catch (e) {
      if (e.message.includes("reverted")) throw e;
    }
  }
  throw new Error("UserOp not mined in 15s");
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const key = process.env.PRIVATE_KEY;
  if (!key) throw new Error("Set PRIVATE_KEY in .env");
  if (!KASPA_ADDRESS) throw new Error("Set KASPA_ADDRESS env var");

  const provider = new ethers.JsonRpcProvider(IGRA_RPC);
  const wallet = new ethers.Wallet(key);

  // Compute smart account address (counterfactual)
  // NOTE: ethers.Contract wrapper misroutes getAddress — use raw call
  const getAddrIface = new ethers.Interface(["function getAddress(address,uint256) view returns (address)"]);
  const getAddrResult = await provider.call({
    to: FACTORY,
    data: getAddrIface.encodeFunctionData("getAddress", [wallet.address, 0n]),
  });
  const smartAccount = getAddrIface.decodeFunctionResult("getAddress", getAddrResult)[0];

  console.log("=== Gasless Buy KAS ===");
  console.log(`EOA:           ${wallet.address}`);
  console.log(`Smart Account: ${smartAccount}`);
  console.log(`Kaspa dest:    ${KASPA_ADDRESS}`);
  console.log(`Paymaster:     ${PAYMASTER}`);
  console.log("");

  // Check USDC balance on smart account
  const usdc = new ethers.Contract(USDC, ERC20, provider);
  const usdcBal = await usdc.balanceOf(smartAccount);
  console.log(`USDC on smart account: ${ethers.formatUnits(usdcBal, 6)}`);

  if (usdcBal === 0n) {
    console.log("\nNo USDC on smart account. Bridge USDC to this address:");
    console.log(`  ${smartAccount}`);
    console.log("\nUse Hyperlane:");
    console.log(`  https://nexus.hyperlane.xyz/?destination=igra&destinationToken=USDC&origin=base&originToken=USDC`);
    console.log("\nRun this script again after USDC arrives.");
    return;
  }

  // Reserve 10% for paymaster gas fees (~3 UserOps × $0.05 = $0.15)
  const swapAmount = usdcBal * 90n / 100n;
  console.log(`Swap amount:   ${ethers.formatUnits(swapAmount, 6)} USDC (90%, rest for gas)\n`);

  // Get pool reserves and expected output
  const pool = new ethers.Contract(POOL, PAIR, provider);
  const [r0, r1] = await pool.getReserves();
  // token0 = WiKAS (18 dec), token1 = USDC (6 dec)
  const expectedWikas = getAmountOut(swapAmount, r1, r0);
  const block = await provider.getBlock("latest");
  const deadline = block.timestamp + 600;

  console.log(`Pool: ${ethers.formatEther(r0)} WiKAS / ${ethers.formatUnits(r1, 6)} USDC`);
  console.log(`Expected: ~${ethers.formatEther(expectedWikas)} WiKAS`);
  console.log("");

  // ══════════════════════════════════════════════════════════════════
  // UserOp 1: Create account + approve paymaster + approve router + swap
  // ══════════════════════════════════════════════════════════════════

  console.log("--- UserOp 1: Create + Approve + Swap USDC→WiKAS ---");
  await sendUserOp(provider, wallet, smartAccount, batch([
    { target: USDC, value: 0n, data: encode(ERC20, "approve", [PAYMASTER, ethers.MaxUint256]) },
    { target: USDC, value: 0n, data: encode(ERC20, "approve", [ROUTER, swapAmount]) },
    { target: ROUTER, value: 0n, data: encode(
      ["function swapExactTokensForTokens(uint,uint,address[],address,uint) returns (uint[])"],
      "swapExactTokensForTokens",
      [swapAmount, 0n, [USDC, WIKAS], smartAccount, deadline]
    )},
  ]), true); // isFirst = true → deploys smart account

  const wikasBalance = await new ethers.Contract(WIKAS, ERC20, provider).balanceOf(smartAccount);
  console.log(`  WiKAS balance: ${ethers.formatEther(wikasBalance)}\n`);

  // ══════════════════════════════════════════════════════════════════
  // UserOp 2: Unwrap WiKAS → iKAS
  // ══════════════════════════════════════════════════════════════════

  console.log("--- UserOp 2: Unwrap WiKAS → iKAS ---");
  await sendUserOp(provider, wallet, smartAccount, batch([
    { target: WIKAS, value: 0n, data: encode(["function withdraw(uint256)"], "withdraw", [wikasBalance]) },
  ]));

  const ikasBalance = await provider.getBalance(smartAccount);
  console.log(`  iKAS balance: ${ethers.formatEther(ikasBalance)}\n`);

  // ══════════════════════════════════════════════════════════════════
  // UserOp 3: lockForExit (full iKAS balance → KAS on L1)
  // ══════════════════════════════════════════════════════════════════

  console.log("--- UserOp 3: Lock iKAS for exit to Kaspa L1 ---");
  const exitAmount = ikasBalance - ethers.parseEther("0.1"); // minimal buffer

  if (exitAmount < ethers.parseEther("11")) {
    console.log(`  iKAS balance too low for KasBridge exit (need >11, have ${ethers.formatEther(ikasBalance)})`);
    console.log("  iKAS stays on smart account. Done.");
    return;
  }

  const exitCounterBefore = await new ethers.Contract(KASBRIDGE, KASBRIDGE_ABI, provider).exitCounter();

  await sendUserOp(provider, wallet, smartAccount, batch([
    { target: KASBRIDGE, value: exitAmount, data: encode(
      ["function lockForExit(bytes kaspaAddress) payable"],
      "lockForExit",
      [ethers.toUtf8Bytes(KASPA_ADDRESS)]
    )},
  ]));

  const exitId = exitCounterBefore;
  console.log(`  Exit ID: ${exitId}`);
  console.log(`  Exit amount: ${ethers.formatEther(exitAmount)} iKAS\n`);

  // ══════════════════════════════════════════════════════════════════
  // Wait for L1 release
  // ══════════════════════════════════════════════════════════════════

  console.log("--- Waiting for KAS release on Kaspa L1 (~10 min) ---");
  const kasBridge = new ethers.Contract(KASBRIDGE, KASBRIDGE_ABI, provider);
  while (true) {
    const exit = await kasBridge.exits(exitId);
    if (exit[7] && exit[9] !== ethers.ZeroHash) { // processed && kaspaTxHash != 0
      console.log(`  KAS released! Kaspa TX: ${exit[9]}`);
      break;
    }
    if (exit[6]) { // acknowledged
      process.stdout.write("*");
    } else {
      process.stdout.write(".");
    }
    await new Promise(r => setTimeout(r, 15_000));
  }

  // Final summary
  const remainingUsdc = await usdc.balanceOf(smartAccount);
  console.log("\n\n=== Done ===");
  console.log(`Swapped: ${ethers.formatUnits(swapAmount, 6)} USDC → ${ethers.formatEther(exitAmount)} iKAS → KAS`);
  console.log(`Paymaster fees: ~${ethers.formatUnits(usdcBal - swapAmount - remainingUsdc, 6)} USDC`);
  console.log(`KAS delivered to: ${KASPA_ADDRESS}`);
}

main().catch(e => {
  console.error("\nERROR:", e.message || e);
  process.exit(1);
});
