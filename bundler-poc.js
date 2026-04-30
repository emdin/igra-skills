/**
 * PoC: ERC-4337 + EIP-7702 batched swap via bundler
 *
 * Batches: approve WiKAS + swap WiKAS→USDC in a single UserOperation
 * Uses Simple7702Account delegation via the bundler at bubundler.jobberwocky.co
 *
 * Usage: node bundler-poc.js
 */

const { ethers } = require("ethers");
require("dotenv").config();

const IGRA_RPC = "https://rpc.igralabs.com:8545";
const BUNDLER_RPC = "https://bubundler.jobberwocky.co";
const EP = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const SIMPLE_7702 = "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9";

const WIKAS = "0x17Ec7E1768c813E2a3a9b0f94A35605CA520C242";
const USDC = "0xA5b8BF902b2844dA17d4506cc827F7F1681735E7";
const ROUTER = "0xA5B0946D31aD2d251e0fe2dfEA8808BFd475e607";
const POOL = "0x7826f5421c324590b1c21d22231c48ad059cbe45";

// ── Helpers ──────────────────────────────────────────────────────────

async function bundlerCall(method, params) {
  const r = await fetch(BUNDLER_RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: Date.now() }),
  });
  const d = await r.json();
  if (d.error) throw new Error(`Bundler ${method}: ${JSON.stringify(d.error)}`);
  return d.result;
}

function packGasLimits(verificationGasLimit, callGasLimit) {
  // accountGasLimits = bytes32: upper 128 bits = verificationGasLimit, lower 128 bits = callGasLimit
  const vgl = BigInt(verificationGasLimit).toString(16).padStart(32, "0");
  const cgl = BigInt(callGasLimit).toString(16).padStart(32, "0");
  return "0x" + vgl + cgl;
}

function packGasFees(maxPriorityFeePerGas, maxFeePerGas) {
  const mpf = BigInt(maxPriorityFeePerGas).toString(16).padStart(32, "0");
  const mfpg = BigInt(maxFeePerGas).toString(16).padStart(32, "0");
  return "0x" + mpf + mfpg;
}

function amtOut(a, rIn, rOut) {
  const f = a * 997n;
  return (f * rOut) / (rIn * 1000n + f);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const provider = new ethers.JsonRpcProvider(IGRA_RPC);
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
  const addr = wallet.address;

  console.log("=== Bundler PoC: Batched Approve + Swap ===");
  console.log("Wallet:", addr);
  console.log("EntryPoint:", EP);
  console.log("Simple7702Account:", SIMPLE_7702);
  console.log("");

  // ── Check state ──
  const wikas = new ethers.Contract(WIKAS, [
    "function balanceOf(address) view returns (uint256)",
  ], provider);
  const wBal = await wikas.balanceOf(addr);
  console.log("WiKAS balance:", ethers.formatEther(wBal));
  console.log("iKAS balance:", ethers.formatEther(await provider.getBalance(addr)));

  if (wBal === 0n) {
    console.log("No WiKAS — wrap some first");
    return;
  }

  // ── Build batch calldata ──
  // Call 1: WiKAS.approve(ROUTER, wBal)
  const approveData = new ethers.Interface([
    "function approve(address,uint256) returns (bool)",
  ]).encodeFunctionData("approve", [ROUTER, wBal]);

  // Call 2: router.swapExactTokensForTokens(wBal, 0, [WIKAS, USDC], addr, deadline)
  const pool = new ethers.Contract(POOL, [
    "function getReserves() view returns (uint112,uint112,uint32)",
  ], provider);
  const [r0, r1] = await pool.getReserves();
  const expected = amtOut(wBal, r0, r1);
  const block = await provider.getBlock("latest");
  const deadline = block.timestamp + 600;

  const swapData = new ethers.Interface([
    "function swapExactTokensForTokens(uint,uint,address[],address,uint) returns (uint[])",
  ]).encodeFunctionData("swapExactTokensForTokens", [
    wBal, 0n, [WIKAS, USDC], addr, deadline,
  ]);

  console.log("\nBatch calls:");
  console.log("  1. WiKAS.approve(Router, " + ethers.formatEther(wBal) + ")");
  console.log("  2. Router.swap(" + ethers.formatEther(wBal) + " WiKAS → ~" + ethers.formatUnits(expected, 6) + " USDC)");

  // ── Encode executeBatch calldata ──
  const executeBatchData = new ethers.Interface([
    "function executeBatch((address target, uint256 value, bytes data)[] calls)",
  ]).encodeFunctionData("executeBatch", [[
    { target: WIKAS, value: 0n, data: approveData },
    { target: ROUTER, value: 0n, data: swapData },
  ]]);

  // ── Get EntryPoint nonce ──
  const epContract = new ethers.Contract(EP, [
    "function getNonce(address,uint192) view returns (uint256)",
  ], provider);
  const nonce = await epContract.getNonce(addr, 0);
  console.log("\nEntryPoint nonce:", nonce.toString());

  // ── Build UserOperation (v0.7 packed format) ──
  const gasPrice = 1200000000000n; // 1200 gwei (bundler's price)

  const userOp = {
    sender: addr,
    nonce: ethers.toBeHex(nonce),
    initCode: "0x",  // no deployment needed with 7702
    callData: executeBatchData,
    accountGasLimits: packGasLimits(200000, 500000), // verificationGas, callGas
    preVerificationGas: ethers.toBeHex(100000),
    gasFees: packGasFees(gasPrice, gasPrice), // priorityFee, maxFee
    paymasterAndData: "0x",
    signature: "0x", // placeholder for estimation
  };

  console.log("\n--- Step 1: Estimate gas via bundler ---");
  try {
    const estimation = await bundlerCall("eth_estimateUserOperationGas", [userOp, EP]);
    console.log("Gas estimation:", JSON.stringify(estimation, null, 2));

    // Update gas limits from estimation
    const pvg = BigInt(estimation.preVerificationGas);
    const vgl = BigInt(estimation.verificationGasLimit);
    const cgl = BigInt(estimation.callGasLimit);
    console.log("  preVerificationGas:", pvg.toString());
    console.log("  verificationGasLimit:", vgl.toString());
    console.log("  callGasLimit:", cgl.toString());

    userOp.preVerificationGas = ethers.toBeHex(pvg);
    userOp.accountGasLimits = packGasLimits(vgl, cgl);
  } catch (e) {
    console.log("Estimation error:", e.message);
    console.log("\nThis likely means the bundler needs the 7702 authorization.");
    console.log("The bundler may expect it in a specific field of the UserOp.");
    console.log("Or the EOA needs to already be delegated.");
    return;
  }

  // ── Sign the UserOperation ──
  console.log("\n--- Step 2: Sign UserOperation ---");

  // Hash the UserOp for signing (ERC-4337 v0.7 hash)
  const userOpHash = await new ethers.Contract(EP, [
    "function getUserOpHash((address sender, uint256 nonce, bytes initCode, bytes callData, bytes32 accountGasLimits, uint256 preVerificationGas, bytes32 gasFees, bytes paymasterAndData, bytes signature)) view returns (bytes32)",
  ], provider).getUserOpHash(userOp);
  console.log("UserOp hash:", userOpHash);

  // Sign with EOA (personal_sign style — wraps in EIP-191)
  const signature = await wallet.signMessage(ethers.getBytes(userOpHash));
  userOp.signature = signature;
  console.log("Signed");

  // ── Submit to bundler ──
  console.log("\n--- Step 3: Submit to bundler ---");
  try {
    const opHash = await bundlerCall("eth_sendUserOperation", [userOp, EP]);
    console.log("UserOperation submitted! Hash:", opHash);

    // Poll for receipt
    console.log("Waiting for receipt...");
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const receipt = await bundlerCall("eth_getUserOperationReceipt", [opHash]);
        if (receipt) {
          console.log("\nUserOperation mined!");
          console.log("  Success:", receipt.success);
          console.log("  Tx hash:", receipt.receipt?.transactionHash);
          console.log("  Block:", receipt.receipt?.blockNumber);
          console.log("  Gas used:", parseInt(receipt.actualGasUsed, 16));

          // Check result
          const usdcC = new ethers.Contract(USDC, [
            "function balanceOf(address) view returns (uint256)",
          ], provider);
          console.log("\n  USDC after:", ethers.formatUnits(await usdcC.balanceOf(addr), 6));
          console.log("  WiKAS after:", ethers.formatEther(await wikas.balanceOf(addr)));
          return;
        }
      } catch {}
      process.stdout.write(".");
    }
    console.log("\nTimeout waiting for receipt");
  } catch (e) {
    console.log("Submit error:", e.message);
  }
}

main().catch(e => console.error("ERROR:", e.message));
