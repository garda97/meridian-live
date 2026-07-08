import {
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";
import bs58 from "bs58";
import { log } from "../logger.js";
import { config } from "../config.js";
import { heliusFetch, getHeliusKeys } from "../utils/helius-rotator.js";
import { withHeliusRpcRetry } from "../utils/rpc-connection.js";
import { fetchWithTimeout } from "../utils/fetch-timeout.js";

let _wallet = null;

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const JUPITER_SWAP_V2_API = "https://api.jup.ag/swap/v2";
const SOL_MINT_PRICE = "So11111111111111111111111111111111111111112";

async function fetchSolPriceUsd() {
  try {
    const res = await fetchWithTimeout(`${JUPITER_PRICE_API}?ids=${SOL_MINT_PRICE}`, {}, 10_000);
    if (!res.ok) return 0;
    const data = await res.json();
    const price = Number(data?.[SOL_MINT_PRICE]?.usdPrice ?? data?.data?.[SOL_MINT_PRICE]?.price ?? 0);
    return Number.isFinite(price) ? price : 0;
  } catch {
    return 0;
  }
}

// Cached live SOL price for metrics (est share, sizing math) — one Jupiter
// call per 5 minutes instead of a hardcoded constant. Returns null when the
// price is unavailable so callers can skip the metric rather than mislead.
let _solPriceCache = { price: null, at: 0 };
const SOL_PRICE_TTL_MS = 5 * 60_000;

export async function getSolPriceUsd() {
  if (_solPriceCache.price != null && Date.now() - _solPriceCache.at < SOL_PRICE_TTL_MS) {
    return _solPriceCache.price;
  }
  const price = await fetchSolPriceUsd();
  if (price > 0) {
    _solPriceCache = { price: Math.round(price * 100) / 100, at: Date.now() };
    return _solPriceCache.price;
  }
  // Serve a stale price over nothing; null only when we never had one
  return _solPriceCache.price ?? null;
}

async function getWalletBalancesViaRpc(walletAddress) {
  let lamports = null;
  let rpcSource = "helius";
  try {
    lamports = await withHeliusRpcRetry(
      (conn) => conn.getBalance(new PublicKey(walletAddress), "confirmed"),
    );
  } catch (heliusErr) {
    log("wallet_fallback", `Helius RPC getBalance failed (${heliusErr.message}) — trying public Solana RPC`);
    try {
      const { Connection } = await import("@solana/web3.js");
      const pub = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
      lamports = await pub.getBalance(new PublicKey(walletAddress), "confirmed");
      rpcSource = "public";
    } catch (pubErr) {
      log("wallet_error", `Public RPC getBalance also failed: ${pubErr.message}`);
      throw heliusErr;
    }
  }
  const sol = (lamports ?? 0) / LAMPORTS_PER_SOL;
  const solPrice = await fetchSolPriceUsd();
  const solUsd = solPrice > 0 ? sol * solPrice : 0;
  return {
    wallet: walletAddress,
    sol: Math.round(sol * 1e6) / 1e6,
    sol_price: Math.round(solPrice * 100) / 100,
    sol_usd: Math.round(solUsd * 100) / 100,
    usdc: 0,
    tokens: [],
    total_usd: Math.round(solUsd * 100) / 100,
    source: `rpc_fallback_${rpcSource}`,
  };
}
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function getJupiterApiKey() {
  return config.jupiter.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
}

function getJupiterReferralParams() {
  const referralAccount = String(config.jupiter.referralAccount || "").trim();
  const referralFee = Number(config.jupiter.referralFeeBps || 0);
  if (!referralAccount || !Number.isFinite(referralFee) || referralFee <= 0) {
    return null;
  }
  if (referralFee < 50 || referralFee > 255) {
    log("swap_warn", `Ignoring Jupiter referral fee ${referralFee}; Ultra requires 50-255 bps`);
    return null;
  }
  try {
    new PublicKey(referralAccount);
  } catch {
    log("swap_warn", "Ignoring invalid Jupiter referral account");
    return null;
  }
  return { referralAccount, referralFee: Math.round(referralFee) };
}

/**
 * Get current wallet balances: SOL, USDC, and all SPL tokens using Helius Wallet API.
 * Returns USD-denominated values provided by Helius.
 */
export async function getWalletBalances() {
  let walletAddress;
  try {
    walletAddress = getWallet().publicKey.toString();
  } catch {
    return { wallet: null, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: "Wallet not configured" };
  }

  try {
    getHeliusKeys();
  } catch (err) {
    log("wallet_fallback", `Helius keys unavailable (${err.message}) — using public RPC for balance`);
    try {
      return await getWalletBalancesViaRpc(walletAddress);
    } catch (rpcErr) {
      return { wallet: walletAddress, sol: 0, sol_price: 0, sol_usd: 0, usdc: 0, tokens: [], total_usd: 0, error: rpcErr.message };
    }
  }

  try {
    let data;
    try {
      const res = await heliusFetch(
        (key) => `https://api.helius.xyz/v1/wallet/${walletAddress}/balances?api-key=${key}`,
      );
      data = await res.json();
    } catch (apiErr) {
      log("wallet_fallback", `Helius wallet API failed (${apiErr.message}) — using RPC getBalance`);
      return getWalletBalancesViaRpc(walletAddress);
    }
    const balances = data.balances || [];

    // ─── Find SOL and USDC ────────────────────────────────────
    const solEntry = balances.find(b => b.mint === config.tokens.SOL || b.symbol === "SOL");
    const usdcEntry = balances.find(b => b.mint === config.tokens.USDC || b.symbol === "USDC");

    const solBalance = solEntry?.balance || 0;
    const solPrice = solEntry?.pricePerToken || 0;
    const solUsd = solEntry?.usdValue || 0;
    const usdcBalance = usdcEntry?.balance || 0;

    // ─── Map all tokens ───────────────────────────────────────
    const enrichedTokens = balances.map(b => ({
      mint: b.mint,
      symbol: b.symbol || b.mint.slice(0, 8),
      balance: b.balance,
      usd: b.usdValue ? Math.round(b.usdValue * 100) / 100 : null,
    }));

    return {
      wallet: walletAddress,
      sol: Math.round(solBalance * 1e6) / 1e6,
      sol_price: Math.round(solPrice * 100) / 100,
      sol_usd: Math.round(solUsd * 100) / 100,
      usdc: Math.round(usdcBalance * 100) / 100,
      tokens: enrichedTokens,
      total_usd: Math.round((data.totalUsdValue || 0) * 100) / 100,
    };
  } catch (error) {
    log("wallet_error", error.message);
    try {
      return await getWalletBalancesViaRpc(walletAddress);
    } catch (rpcError) {
      return {
        wallet: walletAddress,
        sol: 0,
        sol_price: 0,
        sol_usd: 0,
        usdc: 0,
        tokens: [],
        total_usd: 0,
        error: rpcError.message || error.message,
      };
    }
  }
}

/**
 * Swap tokens via Jupiter Swap API V2 (order → sign → execute).
 */
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Normalize any SOL-like address to the correct wrapped SOL mint
export function normalizeMint(mint) {
  if (!mint) return mint;
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (
    mint === "SOL" || 
    mint === "native" || 
    /^So1+$/.test(mint) || 
    (mint.length >= 32 && mint.length <= 44 && mint.startsWith("So1") && mint !== SOL_MINT)
  ) {
    return SOL_MINT;
  }
  return mint;
}

export async function swapToken({
  input_mint,
  output_mint,
  amount,
}) {
  input_mint  = normalizeMint(input_mint);
  output_mint = normalizeMint(output_mint);

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_swap: { input_mint, output_mint, amount },
      message: "DRY RUN — no transaction sent",
    };
  }

  try {
    log("swap", `${amount} of ${input_mint} → ${output_mint}`);
    const wallet = getWallet();

    // ─── Convert to smallest unit ──────────────────────────────
    let decimals = 9; // SOL default
    if (input_mint !== config.tokens.SOL) {
      // Use heliusFetch for mint info lookup
      try {
        const mintData = await heliusFetch(`/v0/token?address=${input_mint}`);
        decimals = mintData?.decimals ?? 9;
      } catch {
        // Fallback to 6 decimals (pump.fun default)
        decimals = 6;
      }
    }
    const amountStr = Math.floor(amount * Math.pow(10, decimals)).toString();

    // ─── Get Swap V2 order (unsigned tx + requestId) ───────────
    const search = new URLSearchParams({
      inputMint: input_mint,
      outputMint: output_mint,
      amount: amountStr,
      taker: wallet.publicKey.toString(),
    });
    const referralParams = getJupiterReferralParams();
    if (referralParams) {
      search.set("referralAccount", referralParams.referralAccount);
      search.set("referralFee", String(referralParams.referralFee));
    }
    const orderUrl = `${JUPITER_SWAP_V2_API}/order?${search.toString()}`;
    const jupiterApiKey = getJupiterApiKey();

    // Add 30-second timeout to fetch
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    let orderRes;
    try {
      orderRes = await fetch(orderUrl, {
        headers: jupiterApiKey ? { "x-api-key": jupiterApiKey } : {},
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!orderRes.ok) {
      const body = await orderRes.text();
      throw new Error(`Swap V2 order failed: ${orderRes.status} ${body}`);
    }

    const order = await orderRes.json();
    if (order.errorCode || order.errorMessage) {
      throw new Error(`Swap V2 order error: ${order.errorMessage || order.errorCode}`);
    }

    const { transaction: unsignedTx, requestId } = order;

    // ─── Deserialize and sign ─────────────────────────────────
    const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTx, "base64"));
    tx.sign([wallet]);
    const signedTx = Buffer.from(tx.serialize()).toString("base64");

    // ─── Execute ───────────────────────────────────────────────
    const execController = new AbortController();
    const execTimeout = setTimeout(() => execController.abort(), 30000);

    let execRes;
    try {
      execRes = await fetch(`${JUPITER_SWAP_V2_API}/execute`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(jupiterApiKey ? { "x-api-key": jupiterApiKey } : {}),
        },
        body: JSON.stringify({ signedTransaction: signedTx, requestId }),
        signal: execController.signal,
      });
    } finally {
      clearTimeout(execTimeout);
    }

    if (!execRes.ok) {
      throw new Error(`Swap V2 execute failed: ${execRes.status} ${await execRes.text()}`);
    }

    const result = await execRes.json();
    if (result.status === "Failed") {
      throw new Error(`Swap failed on-chain: code=${result.code}`);
    }

    log("swap", `SUCCESS tx: ${result.signature}`);
    if (referralParams && order.feeBps !== referralParams.referralFee) {
      log(
        "swap_warn",
        `Jupiter referral fee requested ${referralParams.referralFee} bps but order applied ${order.feeBps ?? "unknown"} bps`,
      );
    }

    return {
      success: true,
      tx: result.signature,
      input_mint,
      output_mint,
      amount_in: result.inputAmountResult,
      amount_out: result.outputAmountResult,
      referral_account: referralParams?.referralAccount || null,
      referral_fee_bps_requested: referralParams?.referralFee || 0,
      fee_bps_applied: order.feeBps ?? null,
      fee_mint: order.feeMint ?? null,
    };
  } catch (error) {
    log("swap_error", error.message);
    return { success: false, error: error.message };
  }
}
