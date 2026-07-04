import {
  Connection,
  Keypair,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config, computeDeployAmount, MIN_SAFE_BINS_BELOW } from "../config.js";
import { log } from "../logger.js";
import {
  trackPosition,
  markOutOfRange,
  markInRange,
  recordClaim,
  recordClose,
  recordPartialTpAttempt,
  markPartialTpDone,
  recordRebalance,
  recordRebalanceAttempt,
  getTrackedPosition,
  minutesOutOfRange,
  syncOpenPositions,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import {
  addPoolNote,
  getBaseMintCooldownReason,
  getPoolCooldownReason,
  isBaseMintOnCooldown,
  isPoolOnCooldown,
  recordPoolDeploy,
} from "../pool-memory.js";
import { getWalletBalances, normalizeMint } from "./wallet.js";
import { appendDecision } from "../decision-log.js";
import { agentMeridianJson, getAgentIdForRequests, getAgentMeridianHeaders } from "./agent-meridian.js";
import { getAndClearStagedSignals } from "../signal-tracker.js";
import { computePositions, fetchDlmmPnlForPool } from "./pnl.js";
import { getRpcConnection } from "../utils/rpc-connection.js";

// ─── Lazy SDK loader ───────────────────────────────────────────
// @meteora-ag/dlmm → @coral-xyz/anchor uses CJS directory imports
// that break in ESM on Node 24. Dynamic import defers loading until
// an actual on-chain call is needed (never triggered in dry-run).
let _DLMM = null;
let _StrategyType = null;
let _getBinIdFromPrice = null;
let _getPriceOfBinByBinId = null;
let _getBinArrayKeysCoverage = null;
let _getBinArrayIndexesCoverage = null;
let _deriveBinArrayBitmapExtension = null;
let _isOverflowDefaultBinArrayBitmap = null;
let _BIN_ARRAY_FEE = null;
let _BIN_ARRAY_BITMAP_FEE = null;

async function getDLMM() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
    _getBinIdFromPrice = mod.default?.getBinIdFromPrice;
    _getPriceOfBinByBinId = mod.getPriceOfBinByBinId;
    _getBinArrayKeysCoverage = mod.getBinArrayKeysCoverage;
    _getBinArrayIndexesCoverage = mod.getBinArrayIndexesCoverage;
    _deriveBinArrayBitmapExtension = mod.deriveBinArrayBitmapExtension;
    _isOverflowDefaultBinArrayBitmap = mod.isOverflowDefaultBinArrayBitmap;
    _BIN_ARRAY_FEE = mod.BIN_ARRAY_FEE;
    _BIN_ARRAY_BITMAP_FEE = mod.BIN_ARRAY_BITMAP_FEE;
  }
  return {
    DLMM: _DLMM,
    StrategyType: _StrategyType,
    getBinIdFromPrice: _getBinIdFromPrice,
    getPriceOfBinByBinId: _getPriceOfBinByBinId,
    getBinArrayKeysCoverage: _getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage: _getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension: _deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap: _isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE: _BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE: _BIN_ARRAY_BITMAP_FEE,
  };
}

// ─── Lazy wallet/connection init ──────────────────────────────
// Avoids crashing on import when WALLET_PRIVATE_KEY is not yet set
// (e.g. during screening-only tests).
let _wallet = null;

function getConnection() {
  return getRpcConnection();
}

function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) {
      throw new Error("WALLET_PRIVATE_KEY not set");
    }
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    log("init", `Wallet: ${_wallet.publicKey.toString()}`);
  }
  return _wallet;
}

function shouldUseLpAgentRelay() {
  return !!config.api.lpAgentRelayEnabled;
}

function shouldUseLpAgentRelayForDeploy() {
  // Zap-in relay is intentionally disabled; deploys use the local Meteora SDK path.
  return false;
}

function signSerializedTransaction(serialized, wallet) {
  const bytes = Buffer.from(serialized, "base64");
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    versioned.sign([wallet]);
    return Buffer.from(versioned.serialize()).toString("base64");
  } catch {
    const legacy = Transaction.from(bytes);
    legacy.partialSign(wallet);
    return legacy
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64");
  }
}

function deserializeSignedTransaction(signedBase64) {
  const bytes = Buffer.from(signedBase64, "base64");
  try {
    return VersionedTransaction.deserialize(bytes);
  } catch {
    return Transaction.from(bytes);
  }
}

function getStaticAccountKeyStrings(tx) {
  if (tx instanceof VersionedTransaction) {
    return tx.message.staticAccountKeys.map((key) => key.toString());
  }
  return tx.compileMessage().accountKeys.map((key) => key.toString());
}

function getTransactionInstructions(tx) {
  if (!(tx instanceof VersionedTransaction)) return tx.instructions;

  const keys = tx.message.staticAccountKeys;
  return tx.message.compiledInstructions
    .map((ix) => {
      const programId = keys[ix.programIdIndex];
      if (!programId) return null;
      const indexes = ix.accountKeyIndexes || ix.accounts || [];
      const accounts = indexes
        .map((accountIndex) => keys[accountIndex])
        .filter(Boolean);
      return new TransactionInstruction({
        programId,
        keys: accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
        data: Buffer.from(ix.data),
      });
    })
    .filter(Boolean);
}

function assertNoUnsafeSystemTransfer(tx, wallet, allowedDestinations = []) {
  const owner = wallet.publicKey.toString();
  const allowed = new Set(allowedDestinations.filter(Boolean).map(String));

  for (const ix of getTransactionInstructions(tx)) {
    if (!ix.programId.equals(SystemProgram.programId)) continue;

    let type = null;
    try {
      type = SystemInstruction.decodeInstructionType(ix);
    } catch {
      continue;
    }
    if (type !== "Transfer" && type !== "TransferWithSeed") continue;

    const decoded = type === "Transfer"
      ? SystemInstruction.decodeTransfer(ix)
      : SystemInstruction.decodeTransferWithSeed(ix);
    const source = decoded.fromPubkey?.toString();
    const destination = decoded.toPubkey?.toString();
    if (source === owner && !allowed.has(destination)) {
      throw new Error(
        `Relay transaction contains direct SOL transfer from owner to ${destination?.slice(0, 8) || "unknown"}.`,
      );
    }
  }
}

function signSerializedTransactions(serializedTxs, wallet) {
  return (serializedTxs || [])
    .filter((entry) => typeof entry === "string" && entry.length > 0)
    .map((entry) => signSerializedTransaction(entry, wallet));
}

async function signAndSimulateRelayTransactions(serializedTxs, wallet, {
  label,
  allowedDebitMints = [],
  allowedSystemTransferDestinations = [],
  maxSolLoss = 0.05,
  requiredStaticAccounts = [],
} = {}) {
  const signed = [];
  const owner = wallet.publicKey.toString();
  const allowedMints = new Set(allowedDebitMints.filter(Boolean).map(String));
  const maxLamportLoss = Math.floor(Number(maxSolLoss) * 1e9);

  for (const [index, serialized] of (serializedTxs || []).entries()) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;

    const signedBase64 = signSerializedTransaction(serialized, wallet);
    const tx = deserializeSignedTransaction(signedBase64);
    assertNoUnsafeSystemTransfer(tx, wallet, allowedSystemTransferDestinations);
    const staticKeys = getStaticAccountKeyStrings(tx);
    for (const account of requiredStaticAccounts.filter(Boolean)) {
      if (!staticKeys.includes(String(account))) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} missing required account ${String(account).slice(0, 8)}.`);
      }
    }

    const ownerIndex = staticKeys.indexOf(owner);
    const simulation = await getConnection().simulateTransaction(tx, {
      sigVerify: false,
      replaceRecentBlockhash: false,
    });
    const value = simulation.value;
    if (value.err) {
      throw new Error(`Relay ${label || "transaction"} ${index + 1} simulation failed: ${JSON.stringify(value.err)}`);
    }

    if (ownerIndex >= 0 && value.preBalances?.[ownerIndex] != null && value.postBalances?.[ownerIndex] != null) {
      const lamportDelta = value.postBalances[ownerIndex] - value.preBalances[ownerIndex];
      if (lamportDelta < -maxLamportLoss) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit ${(Math.abs(lamportDelta) / 1e9).toFixed(6)} SOL from owner.`,
        );
      }
    }

    const preByMint = new Map();
    for (const balance of value.preTokenBalances || []) {
      if (balance.owner !== owner) continue;
      preByMint.set(balance.mint, BigInt(balance.uiTokenAmount?.amount || "0"));
    }
    for (const balance of value.postTokenBalances || []) {
      if (balance.owner !== owner) continue;
      const preAmount = preByMint.get(balance.mint) ?? 0n;
      const postAmount = BigInt(balance.uiTokenAmount?.amount || "0");
      if (postAmount < preAmount && !allowedMints.has(balance.mint)) {
        throw new Error(
          `Relay ${label || "transaction"} ${index + 1} would debit unrelated token mint ${balance.mint}.`,
        );
      }
      preByMint.delete(balance.mint);
    }
    for (const [mint, preAmount] of preByMint) {
      if (preAmount > 0n && !allowedMints.has(mint)) {
        throw new Error(`Relay ${label || "transaction"} ${index + 1} would close/debit unrelated token mint ${mint}.`);
      }
    }

    signed.push(signedBase64);
  }

  return signed;
}

function normalizeExecutionSignatures(result) {
  const signatures = [];
  const seen = new Set();
  for (const value of []
    .concat(result?.signatures || [])
    .concat(result?.result?.txHashes || [])
    .concat(result?.result?.signatures || [])
    .concat(result?.result?.signature ? [result.result.signature] : [])) {
    if (typeof value !== "string" || !value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    signatures.push(value);
  }
  return signatures;
}

const METEORA_INIT_BIN_ARRAY_DISCRIMINATOR = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]).toString("hex");
const METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR = Buffer.from([47, 157, 226, 180, 12, 240, 33, 71]).toString("hex");

function getDlmmProgramId() {
  return new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
}

function formatSolFee(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number.toFixed(8).replace(/0+$/, "").replace(/\.$/, "") : "unknown";
}

async function assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId) {
  const {
    getBinArrayKeysCoverage,
    getBinArrayIndexesCoverage,
    deriveBinArrayBitmapExtension,
    isOverflowDefaultBinArrayBitmap,
    BIN_ARRAY_FEE,
    BIN_ARRAY_BITMAP_FEE,
  } = await getDLMM();

  if (!getBinArrayKeysCoverage || !getBinArrayIndexesCoverage) {
    throw new Error("Cannot verify Meteora bin-array initialization risk; refusing deploy.");
  }

  const programId = getDlmmProgramId();
  const poolPubkey = new PublicKey(pool.pubkey?.toString?.() || pool.lbPair?.publicKey?.toString?.() || pool.lbPair?.pubkey?.toString?.());
  const lower = new BN(Math.min(minBinId, maxBinId));
  const upper = new BN(Math.max(minBinId, maxBinId));
  const indexes = getBinArrayIndexesCoverage(lower, upper);
  const keys = getBinArrayKeysCoverage(lower, upper, poolPubkey, programId);
  const accounts = await getConnection().getMultipleAccountsInfo(keys, "confirmed");
  const missing = accounts
    .map((account, index) => account ? null : {
      index: indexes[index]?.toString?.() ?? String(index),
      address: keys[index].toString(),
    })
    .filter(Boolean);

  if (missing.length > 0) {
    const totalFee = missing.length * Number(BIN_ARRAY_FEE ?? 0.07143744);
    const sample = missing.slice(0, 3).map((entry) => `${entry.index}:${entry.address.slice(0, 8)}`).join(", ");
    throw new Error(
      `Deploy skipped: selected range requires ${missing.length} missing Meteora bin-array initialization(s) ` +
      `(~${formatSolFee(totalFee)} SOL non-refundable pool rent; ${formatSolFee(BIN_ARRAY_FEE ?? 0.07143744)} SOL each). ` +
      `Missing indexes: ${sample}${missing.length > 3 ? ", ..." : ""}. Pick an already-initialized range/pool.`,
    );
  }

  if (deriveBinArrayBitmapExtension && isOverflowDefaultBinArrayBitmap) {
    const needsBitmapExtension = indexes.some((index) => isOverflowDefaultBinArrayBitmap(index));
    if (needsBitmapExtension) {
      const [bitmapExtension] = deriveBinArrayBitmapExtension(poolPubkey, programId);
      const account = await getConnection().getAccountInfo(bitmapExtension, "confirmed");
      if (!account) {
        throw new Error(
          `Deploy skipped: selected range requires Meteora bin-array bitmap extension initialization ` +
          `(~${formatSolFee(BIN_ARRAY_BITMAP_FEE ?? 0.01180416)} SOL non-refundable pool rent). Pick a closer initialized range/pool.`,
        );
      }
    }
  }
}

function assertNoInitializeBinArrayInstructions(serializedTxs) {
  const offenders = [];
  for (const serialized of serializedTxs || []) {
    if (typeof serialized !== "string" || serialized.length === 0) continue;
    for (const discriminator of getDlmmInstructionDiscriminators(serialized)) {
      if (discriminator === METEORA_INIT_BIN_ARRAY_DISCRIMINATOR) {
        offenders.push("initializeBinArray");
      } else if (discriminator === METEORA_INIT_BITMAP_EXTENSION_DISCRIMINATOR) {
        offenders.push("initializeBinArrayBitmapExtension");
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(
      `Deploy skipped: generated transaction includes Meteora ${[...new Set(offenders)].join(" / ")} ` +
      "instruction(s), which would charge non-refundable pool initialization rent.",
    );
  }
}

function getDlmmInstructionDiscriminators(serialized) {
  const bytes = Buffer.from(serialized, "base64");
  const dlmmProgramId = getDlmmProgramId().toString();
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    return versioned.message.compiledInstructions
      .map((ix) => {
        const programId = versioned.message.staticAccountKeys[ix.programIdIndex]?.toString();
        if (programId !== dlmmProgramId) return null;
        return Buffer.from(ix.data || []).subarray(0, 8).toString("hex");
      })
      .filter(Boolean);
  } catch {
    const legacy = Transaction.from(bytes);
    return legacy.instructions
      .map((ix) => ix.programId.toString() === dlmmProgramId ? Buffer.from(ix.data || []).subarray(0, 8).toString("hex") : null)
      .filter(Boolean);
  }
}

// ─── Pool Cache ────────────────────────────────────────────────
const poolCache = new Map();
const poolMetadataCache = new Map();

async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getDLMM();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

// unref: these cache sweeps must not keep one-shot processes (cli.js, tests) alive
setInterval(() => poolCache.clear(), 5 * 60 * 1000).unref();
setInterval(() => poolMetadataCache.clear(), 15 * 60 * 1000).unref();

async function getPoolMetadata(poolAddress) {
  const key = String(poolAddress);
  if (poolMetadataCache.has(key)) {
    return poolMetadataCache.get(key);
  }

  try {
    const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${key}`);
    if (!res.ok) {
      throw new Error(`Pool metadata API ${res.status}`);
    }

    const data = await res.json();
    const tokenX = data?.token_x?.symbol || null;
    const tokenY = data?.token_y?.symbol || null;
    const pair = data?.name || (tokenX && tokenY ? `${tokenX}-${tokenY}` : null);
    const meta = {
      address: data?.address || key,
      name: pair,
      token_x_symbol: tokenX,
      token_y_symbol: tokenY,
    };
    poolMetadataCache.set(key, meta);
    return meta;
  } catch (error) {
    log("pool_meta_warn", `Pool metadata lookup failed for ${key.slice(0, 8)}: ${error.message}`);
    const fallback = { address: key, name: null, token_x_symbol: null, token_y_symbol: null };
    poolMetadataCache.set(key, fallback);
    return fallback;
  }
}

// ─── Get Active Bin ────────────────────────────────────────────
export async function getActiveBin({ pool_address }) {
  pool_address = normalizeMint(pool_address);
  const pool = await getPool(pool_address);
  const activeBin = await pool.getActiveBin();

  return {
    binId: activeBin.binId,
    price: pool.fromPricePerLamport(Number(activeBin.price)),
    pricePerLamport: activeBin.price.toString(),
  };
}

// ─── Deploy Position ───────────────────────────────────────────
export async function deployPosition({
  pool_address,
  amount_sol, // legacy: will be used as amount_y if amount_y is not provided
  amount_x,
  amount_y,
  strategy,
  bins_below,
  bins_above,
  downside_pct,
  upside_pct,
  // optional pool metadata for learning (passed by agent when available)
  pool_name,
  bin_step,
  base_fee,
  volatility,
  fee_tvl_ratio,
  organic_score,
  initial_value_usd,
  // entry market conditions (injected by executor safety checks)
  entry_mcap,
  entry_tvl,
  entry_volume,
  entry_holders,
  // auto-strategy plan risk score (injected by applyPendingPlanToDeployArgs)
  oor_risk,
  // TGE play flag (injected by applyPendingPlanToDeployArgs) — arms the max-hold close rule
  tge,
}) {
  pool_address = normalizeMint(pool_address);
  const activeStrategy = strategy || config.strategy.strategy;
  let activeBinsBelow = bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow;
  let activeBinsAbove = bins_above ?? 0;
  const parsedVolatility = volatility == null ? null : Number(volatility);
  const normalizedVolatility = parsedVolatility != null && Number.isFinite(parsedVolatility) ? parsedVolatility : null;

  if (volatility != null && (normalizedVolatility == null || normalizedVolatility <= 0)) {
    throw new Error(`Invalid volatility ${volatility} — refusing deploy because the volatility feed is unusable.`);
  }

  if (isPoolOnCooldown(pool_address)) {
    const reason = getPoolCooldownReason(pool_address) || "pool cooldown active";
    log("deploy", `Pool ${pool_address.slice(0, 8)} is on cooldown — skipping (${reason})`);
    return { success: false, error: `Pool on cooldown — ${reason}. Try a different pool.` };
  }

  const { StrategyType, getBinIdFromPrice, getPriceOfBinByBinId } = await getDLMM();
  const pool = await getPool(pool_address);
  const baseMint = pool.lbPair.tokenXMint.toString();
  if (isBaseMintOnCooldown(baseMint)) {
    const reason = getBaseMintCooldownReason(baseMint) || "token cooldown active";
    log("deploy", `Base mint ${baseMint.slice(0, 8)} is on cooldown — skipping deploy (${reason})`);
    return { success: false, error: `Token on cooldown — ${reason}. Try a different token.` };
  }
  // The cached DLMM object can hold lbPair state up to 5 min old, and the SDK
  // passes lbPair.activeId as the on-chain slippage reference — a stale value
  // is exactly what triggers 0x1774 ExceededBinSlippageTolerance.
  try {
    await pool.refetchStates();
  } catch (error) {
    log("deploy", `refetchStates failed (${error.message}) — continuing with cached pool state`);
  }
  const activeBin = await pool.getActiveBin();
  const actualBinStep = pool.lbPair.binStep;
  const activePrice = Number(getPriceOfBinByBinId(activeBin.binId, actualBinStep).toString());

  if (downside_pct != null || upside_pct != null) {
    const downsidePct = Math.max(0, Number(downside_pct ?? 0));
    const upsidePct = Math.max(0, Number(upside_pct ?? 0));

    if (!Number.isFinite(downsidePct) || !Number.isFinite(upsidePct)) {
      throw new Error("downside_pct and upside_pct must be valid numbers.");
    }
    if (downsidePct >= 100) {
      throw new Error("downside_pct must be less than 100.");
    }

    const lowerTargetPrice = activePrice * (1 - downsidePct / 100);
    const upperTargetPrice = activePrice * (1 + upsidePct / 100);
    const lowerBinId = getBinIdFromPrice(lowerTargetPrice, actualBinStep, true);
    const upperBinId = getBinIdFromPrice(upperTargetPrice, actualBinStep, false);

    activeBinsBelow = Math.max(0, activeBin.binId - lowerBinId);
    activeBinsAbove = Math.max(0, upperBinId - activeBin.binId);
  }

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };

  const strategyType = strategyMap[activeStrategy];
  if (strategyType === undefined) {
    throw new Error(`Invalid strategy: ${activeStrategy}. Use spot, curve, or bid_ask.`);
  }

  // Calculate amounts
  // If no explicit SOL amount is provided, fall back to the configured dynamic deploy size.
  const fallbackAmountY =
    amount_y == null && amount_sol == null
      ? computeDeployAmount((await getWalletBalances()).sol)
      : 0;
  const finalAmountY = Number(amount_y ?? amount_sol ?? fallbackAmountY);
  const finalAmountX = Number(amount_x ?? 0);
  if (!Number.isFinite(finalAmountY) || !Number.isFinite(finalAmountX) || finalAmountY < 0 || finalAmountX < 0) {
    throw new Error("Invalid deploy amount: amount_x and amount_y must be valid non-negative numbers.");
  }
  if (finalAmountX > 0) {
    throw new Error("Token-only deploys are not supported yet. Use amount_y/amount_sol with amount_x=0.");
  }
  if (finalAmountY <= 0) {
    throw new Error("Invalid deploy amount: provide a positive amount_y/amount_sol.");
  }
  const isSingleSidedSol = finalAmountX <= 0 && finalAmountY > 0;
  const allowsUpsideBins = activeStrategy === "spot" || activeStrategy === "curve";
  if (isSingleSidedSol && !allowsUpsideBins && (Number(bins_above ?? 0) > 0 || Number(upside_pct ?? 0) > 0)) {
    throw new Error(
      "Single-side SOL bid_ask deploy cannot use bins_above or upside_pct. Use amount_y with bins_below only; the upper bin is the SDK active bin.",
    );
  }
  if (isSingleSidedSol && !allowsUpsideBins) {
    activeBinsAbove = 0;
  }
  activeBinsBelow = Number(activeBinsBelow);
  activeBinsAbove = Number(activeBinsAbove);
  if (!Number.isFinite(activeBinsBelow) || !Number.isFinite(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be valid numbers.");
  }
  if (activeBinsBelow < 0 || activeBinsAbove < 0) {
    throw new Error("Invalid bin range: bins_below and bins_above cannot be negative.");
  }
  if (!Number.isInteger(activeBinsBelow) || !Number.isInteger(activeBinsAbove)) {
    throw new Error("Invalid bin range: bins_below and bins_above must be whole-bin integers.");
  }
  const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
  const totalBins = activeBinsBelow + activeBinsAbove;
  if (totalBins < minBinsBelow) {
    throw new Error(
      `Invalid deploy range: total bins ${totalBins} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
    );
  }

  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_deploy: {
        pool_address,
        strategy: activeStrategy,
        bins_below: activeBinsBelow,
        bins_above: activeBinsAbove,
        downside_pct: downside_pct ?? null,
        upside_pct: upside_pct ?? null,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        wide_range: totalBins > 69,
      },
      message: "DRY RUN — no transaction sent",
    };
  }

  const isWideRange = totalBins > 69;
  const minBinId = activeBin.binId - activeBinsBelow;
  const maxBinId = isSingleSidedSol && !allowsUpsideBins
    ? activeBin.binId
    : activeBin.binId + activeBinsAbove;

  if (minBinId > maxBinId) {
    throw new Error(`Invalid bin range: ${minBinId} -> ${maxBinId}`);
  }
  if (isSingleSidedSol && !allowsUpsideBins && maxBinId !== activeBin.binId) {
    throw new Error(
      `Single-side SOL bid_ask deploy must end at the SDK active bin. Expected ${activeBin.binId}, got ${maxBinId}.`,
    );
  }

  await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);

  const minPrice = Number(getPriceOfBinByBinId(minBinId, actualBinStep).toString());
  const maxPrice = Number(getPriceOfBinByBinId(maxBinId, actualBinStep).toString());
  const downsideCoveragePct = activePrice > 0 ? ((activePrice - minPrice) / activePrice) * 100 : null;
  const upsideCoveragePct = activePrice > 0 ? ((maxPrice - activePrice) / activePrice) * 100 : null;
  const totalWidthPct = minPrice > 0 ? ((maxPrice - minPrice) / minPrice) * 100 : null;

  // Read base fee directly from pool — baseFactor * binStep / 10^6 gives fee in %
  const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
  const actualBaseFee = base_fee ?? (baseFactor > 0 ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4)) : null);

  const totalYLamports = new BN(Math.floor(finalAmountY * 1e9));
  // Token X amount uses mint decimals when available, falling back to 9.
  let totalXLamports = new BN(0);
  if (finalAmountX > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(finalAmountX * Math.pow(10, decimals)));
  }

  if (shouldUseLpAgentRelayForDeploy()) {
    try {
      const wallet = getWallet();
      log(
        "deploy",
        `Relay deploy via Agent Meridian: ${pool_address} activeBin ${activeBin.binId} bins ${minBinId}->${maxBinId} amountY=${finalAmountY}`,
      );
      const order = await agentMeridianJson("/execution/zap-in/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `deploy:${pool_address}:${minBinId}:${maxBinId}:${finalAmountY}:${finalAmountX}`,
          poolId: pool_address,
          owner: wallet.publicKey.toString(),
          strategy: activeStrategy === "spot" ? "Spot" : activeStrategy === "curve" ? "Curve" : "BidAsk",
          inputSOL: finalAmountY,
          amountY: finalAmountY,
          amountX: finalAmountX,
          percentX: finalAmountX > 0 && finalAmountY > 0 ? 0.5 : 0,
          fromBinId: minBinId,
          toBinId: maxBinId,
          slippageBps: 500,
          provider: "JUPITER_ULTRA",
        }),
      });

      const addLiquidityUnsigned = order?.order?.transactions?.addLiquidity || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (addLiquidityUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent order returned no transactions. Check the pool address, deploy amount, and selected range.");
      }
      assertNoInitializeBinArrayInstructions(addLiquidityUnsigned);

      const addLiquidity = signSerializedTransactions(addLiquidityUnsigned, wallet);
      const swap = signSerializedTransactions(swapUnsigned, wallet);
      const submit = await agentMeridianJson("/execution/zap-in/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            addLiquidity,
            swap,
          },
          meta: {
            pool: pool_address,
            strategy: activeStrategy,
          },
        }),
      });

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;
      const refreshed = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const matching = refreshed?.positions?.find(
        (position) => position.pool === pool_address && position.lower_bin === minBinId && position.upper_bin === maxBinId,
      ) || refreshed?.positions?.find((position) => position.pool === pool_address);

      const positionAddress = matching?.position || null;
      const signalSnapshot = getAndClearStagedSignals(pool_address, baseMint);
      if (positionAddress) {
        trackPosition({
          position: positionAddress,
          pool: pool_address,
          pool_name,
          strategy: activeStrategy,
          bin_range: { min: minBinId, max: maxBinId, bins_below: activeBinsBelow, bins_above: activeBinsAbove },
          bin_step,
          volatility: normalizedVolatility,
          fee_tvl_ratio,
          organic_score,
          amount_sol: finalAmountY,
          amount_x: finalAmountX,
          active_bin: activeBin.binId,
          initial_value_usd,
          signal_snapshot: signalSnapshot,
          entry_mcap,
          entry_tvl,
          entry_volume,
          entry_holders,
          tge: tge === true || undefined,
        });
      }

      appendDecision({
        type: "deploy",
        actor: "SCREENER",
        pool: pool_address,
        pool_name,
        position: positionAddress,
        summary: `Relay deployed ${finalAmountY} SOL with ${activeStrategy}`,
        reason: `Chosen range ${minBinId}→${maxBinId} around active bin ${activeBin.binId}`,
        risks: [
          normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
          fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
        ].filter(Boolean),
        metrics: {
          amount_sol: finalAmountY,
          strategy: activeStrategy,
          active_bin: activeBin.binId,
          min_bin: minBinId,
          max_bin: maxBinId,
          downside_pct: downside_pct ?? downsideCoveragePct,
          upside_pct: upside_pct ?? upsideCoveragePct,
          holder_audit: buildHolderAuditSnapshot(signalSnapshot),
          est_share_pct: signalSnapshot?.estimated_share_pct ?? null,
        },
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: positionAddress,
        pool: pool_address,
        pool_name,
        bin_range: { min: minBinId, max: maxBinId, active: activeBin.binId },
        price_range: { min: minPrice, max: maxPrice },
        range_coverage: {
          downside_pct: downsideCoveragePct,
          upside_pct: upsideCoveragePct,
          width_pct: totalWidthPct,
          active_price: activePrice,
        },
        bin_step: actualBinStep,
        base_fee: actualBaseFee,
        strategy: activeStrategy,
        wide_range: isWideRange,
        amount_x: finalAmountX,
        amount_y: finalAmountY,
        txs: normalizeExecutionSignatures(submit),
      };
    } catch (error) {
      log("deploy_error", `Relay deploy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  const wallet = getWallet();
  const spotFeeTvlMin = Number(config.autoStrategy?.spotFeeTvlMin ?? 2);

  // 0x1774 retry ladder — attempt 0 runs the plan as-is; each rung refetches
  // pool state and re-anchors the range to the fresh active bin first.
  let runStrategy = activeStrategy;
  let runBinsBelow = activeBinsBelow;
  let runBinsAbove = activeBinsAbove;
  let runActiveBinId = activeBin.binId;
  let deployed = null;
  let lastError = null;

  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) {
      const plan = planBinSlippageRetry(attempt, {
        strategy: runStrategy,
        binsBelow: runBinsBelow,
        binsAbove: runBinsAbove,
        feeTvlRatio: fee_tvl_ratio,
        minBinsBelow,
        spotFeeTvlMin,
      });
      if (plan.action === "stop") {
        log("deploy", `0x1774 ladder exhausted — ${plan.reason}`);
        break;
      }
      runStrategy = plan.strategy;
      runBinsBelow = plan.binsBelow;
      runBinsAbove = plan.binsAbove;
      try {
        await pool.refetchStates();
      } catch (refetchError) {
        log("deploy", `refetchStates failed on retry (${refetchError.message}) — using getActiveBin only`);
      }
      const freshBin = await pool.getActiveBin();
      runActiveBinId = freshBin.binId;
      log("deploy", `0x1774 retry ${attempt}/3 (${plan.step}): active bin ${runActiveBinId}, ${runStrategy} ${runBinsBelow}/${runBinsAbove}`);
    }

    const runStrategyType = strategyMap[runStrategy];
    const runAllowsUpside = runStrategy === "spot" || runStrategy === "curve";
    const runMinBinId = runActiveBinId - runBinsBelow;
    const runMaxBinId = isSingleSidedSol && !runAllowsUpside ? runActiveBinId : runActiveBinId + runBinsAbove;
    const runIsWide = runBinsBelow + runBinsAbove > 69;
    const newPosition = Keypair.generate();

    if (attempt === 0) {
      log("deploy", `Pool: ${pool_address}`);
      log("deploy", `Strategy: ${runStrategy}, Bins: ${runMinBinId} to ${runMaxBinId} (${runBinsBelow + runBinsAbove} bins${runIsWide ? " — WIDE RANGE" : ""})`);
      log("deploy", `Amount: ${finalAmountX} X, ${finalAmountY} Y`);
    }
    log("deploy", `Position: ${newPosition.publicKey.toString()}`);

    try {
      if (attempt > 0) {
        await assertRangeDoesNotRequireBinArrayInitialization(pool, runMinBinId, runMaxBinId);
      }
      const txHashes = [];

      if (runIsWide) {
        // ── Wide Range Path (>69 bins) ─────────────────────────────────
        // Solana limits inner instruction realloc to 10240 bytes, so we can't create
        // a large position in a single initializePosition ix.
        // Solution: createExtendedEmptyPosition (returns Transaction | Transaction[]),
        //           then addLiquidityByStrategyChunkable (returns Transaction[]).

        // Phase 1: Create empty position (may be multiple txs)
        const createTxs = await pool.createExtendedEmptyPosition(
          runMinBinId,
          runMaxBinId,
          newPosition.publicKey,
          wallet.publicKey,
        );
        const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
        for (let i = 0; i < createTxArray.length; i++) {
          const signers = i === 0 ? [wallet, newPosition] : [wallet];
          const txHash = await sendAndConfirmTransaction(getConnection(), createTxArray[i], signers);
          txHashes.push(txHash);
          log("deploy", `Create tx ${i + 1}/${createTxArray.length}: ${txHash}`);
        }

        try {
          // Phase 2: Add liquidity (may be multiple txs)
          const addTxs = await pool.addLiquidityByStrategyChunkable({
            positionPubKey: newPosition.publicKey,
            user: wallet.publicKey,
            totalXAmount: totalXLamports,
            totalYAmount: totalYLamports,
            strategy: { minBinId: runMinBinId, maxBinId: runMaxBinId, strategyType: runStrategyType },
            slippage: 10, // 10%
          });
          const addTxArray = Array.isArray(addTxs) ? addTxs : [addTxs];
          for (let i = 0; i < addTxArray.length; i++) {
            const txHash = await sendAndConfirmTransaction(getConnection(), addTxArray[i], [wallet]);
            txHashes.push(txHash);
            log("deploy", `Add liquidity tx ${i + 1}/${addTxArray.length}: ${txHash}`);
          }
        } catch (addError) {
          // Empty position already exists on-chain; a ladder retry re-anchors
          // with a new keypair, so reclaim this one's rent first.
          try {
            const orphan = await pool.getPosition(newPosition.publicKey);
            const closeTx = await pool.closePositionIfEmpty({ owner: wallet.publicKey, position: orphan });
            if (closeTx) await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
            log("deploy", `Reclaimed empty position ${newPosition.publicKey.toString().slice(0, 8)} after failed add`);
          } catch (cleanupError) {
            log("deploy", `Could not reclaim empty position ${newPosition.publicKey.toString()}: ${cleanupError.message}`);
          }
          throw addError;
        }
      } else {
        // ── Standard Path (≤69 bins) ─────────────────────────────────
        const tx = await pool.initializePositionAndAddLiquidityByStrategy({
          positionPubKey: newPosition.publicKey,
          user: wallet.publicKey,
          totalXAmount: totalXLamports,
          totalYAmount: totalYLamports,
          strategy: { maxBinId: runMaxBinId, minBinId: runMinBinId, strategyType: runStrategyType },
          slippage: 1000, // 10% in bps
        });
        const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition]);
        txHashes.push(txHash);
      }

      deployed = {
        txHashes,
        position: newPosition.publicKey.toString(),
        minBinId: runMinBinId,
        maxBinId: runMaxBinId,
        activeBinId: runActiveBinId,
        strategy: runStrategy,
        binsBelow: runBinsBelow,
        binsAbove: runBinsAbove,
        isWide: runIsWide,
        retries: attempt,
      };
      break;
    } catch (error) {
      lastError = error;
      if (!isBinSlippageError(error)) break;
      log("deploy", `Bin slippage (0x1774) on attempt ${attempt}: ${error.message}`);
    }
  }

  if (!deployed) {
    const message = lastError?.message ?? "Deploy failed: 0x1774 retry ladder exhausted";
    if (lastError == null || isBinSlippageError(lastError)) {
      addPoolNote({
        pool_address,
        note: `Deploy failed 0x1774 after retry ladder (shift/shrink/spot) — active bin too volatile at ${new Date().toISOString().slice(0, 16)}Z`,
      });
    }
    log("deploy_error", message);
    return { success: false, error: message };
  }

  log("deploy", `SUCCESS — ${deployed.txHashes.length} tx(s): ${deployed.txHashes[0]}${deployed.retries > 0 ? ` (after ${deployed.retries} 0x1774 retr${deployed.retries === 1 ? "y" : "ies"})` : ""}`);

  const finalActivePrice = Number(getPriceOfBinByBinId(deployed.activeBinId, actualBinStep).toString());
  const finalMinPrice = Number(getPriceOfBinByBinId(deployed.minBinId, actualBinStep).toString());
  const finalMaxPrice = Number(getPriceOfBinByBinId(deployed.maxBinId, actualBinStep).toString());
  const finalDownsidePct = finalActivePrice > 0 ? ((finalActivePrice - finalMinPrice) / finalActivePrice) * 100 : null;
  const finalUpsidePct = finalActivePrice > 0 ? ((finalMaxPrice - finalActivePrice) / finalActivePrice) * 100 : null;
  const finalWidthPct = finalMinPrice > 0 ? ((finalMaxPrice - finalMinPrice) / finalMinPrice) * 100 : null;

  _positionsCacheAt = 0;
  // Always consume staged signals — darwin uses them for weighting, the deploy
  // decision log uses them for the holder-audit snapshot.
  const signalSnapshot = getAndClearStagedSignals(pool_address, baseMint);
  trackPosition({
    position: deployed.position,
    pool: pool_address,
    pool_name,
    strategy: deployed.strategy,
    bin_range: { min: deployed.minBinId, max: deployed.maxBinId, bins_below: deployed.binsBelow, bins_above: deployed.binsAbove },
    bin_step,
    volatility: normalizedVolatility,
    fee_tvl_ratio,
    organic_score,
    amount_sol: finalAmountY,
    amount_x: finalAmountX,
    active_bin: deployed.activeBinId,
    initial_value_usd,
    signal_snapshot: signalSnapshot,
    entry_mcap,
    entry_tvl,
    entry_volume,
    entry_holders,
    tge: tge === true || undefined,
  });

  appendDecision({
    type: "deploy",
    actor: "SCREENER",
    pool: pool_address,
    pool_name,
    position: deployed.position,
    summary: `Deployed ${finalAmountY} SOL with ${deployed.strategy}`,
    reason: `Chosen range ${deployed.minBinId}→${deployed.maxBinId} around active bin ${deployed.activeBinId}${deployed.retries > 0 ? ` (0x1774 ladder: ${deployed.retries} retr${deployed.retries === 1 ? "y" : "ies"})` : ""}`,
    risks: [
      normalizedVolatility != null ? `volatility ${normalizedVolatility}` : null,
      fee_tvl_ratio != null ? `fee/TVL ${fee_tvl_ratio}%` : null,
    ].filter(Boolean),
    metrics: {
      amount_sol: finalAmountY,
      strategy: deployed.strategy,
      active_bin: deployed.activeBinId,
      min_bin: deployed.minBinId,
      max_bin: deployed.maxBinId,
      bins_used: deployed.binsBelow + deployed.binsAbove,
      upside_cover_pct: finalUpsidePct != null ? Number(finalUpsidePct.toFixed(2)) : null,
      oor_risk: oor_risk ?? null,
      deploy_retries: deployed.retries,
      downside_pct: downside_pct ?? null,
      upside_pct: upside_pct ?? null,
      holder_audit: buildHolderAuditSnapshot(signalSnapshot),
          est_share_pct: signalSnapshot?.estimated_share_pct ?? null,
    },
  });

  return {
    success: true,
    position: deployed.position,
    pool: pool_address,
    pool_name,
    bin_range: { min: deployed.minBinId, max: deployed.maxBinId, active: deployed.activeBinId },
    price_range: { min: finalMinPrice, max: finalMaxPrice },
    range_coverage: {
      downside_pct: finalDownsidePct,
      upside_pct: finalUpsidePct,
      width_pct: finalWidthPct,
      active_price: finalActivePrice,
    },
    bin_step: actualBinStep,
    base_fee: actualBaseFee,
    strategy: deployed.strategy,
    wide_range: deployed.isWide,
    amount_x: finalAmountX,
    amount_y: finalAmountY,
    deploy_retries: deployed.retries,
    txs: deployed.txHashes,
  };
}

const POSITIONS_CACHE_TTL = 5 * 60_000; // 5 minutes

let _positionsCache = null;
let _positionsCacheAt = 0;
let _positionsInflight = null; // deduplicates concurrent calls
const LPAGENT_API = "https://api.lpagent.io/open-api/v1";

async function fetchLpAgentOpenPositions(walletAddress) {
  if (!process.env.LPAGENT_API_KEY) return {};

  const url = `${LPAGENT_API}/lp-positions/opening?owner=${walletAddress}`;
  try {
    const res = await fetch(url, {
      headers: {
        "x-api-key": process.env.LPAGENT_API_KEY,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("lpagent_api", `HTTP ${res.status} for owner ${walletAddress.slice(0, 8)}: ${body.slice(0, 160)}`);
      return {};
    }
    const data = await res.json();
    const positions = data?.data || [];
    const byAddress = {};
    for (const p of positions) {
      const addr = p.position || p.id || p.tokenId;
      if (addr) byAddress[addr] = p;
    }
    return byAddress;
  } catch (e) {
    log("lpagent_api", `Fetch error for owner ${walletAddress.slice(0, 8)}: ${e.message}`);
    return {};
  }
}

// ─── Get Position PnL (Meteora API) ─────────────────────────────
export async function getPositionPnl({ pool_address, position_address }) {
  pool_address = normalizeMint(pool_address);
  position_address = normalizeMint(position_address);
  const walletAddress = getWallet().publicKey.toString();
  // Prefer the public-infra path (RPC + Jupiter + Meteora deposits) used by getMyPositions.
  if (config.pnl.source === "rpc") {
    try {
      const payload = await getMyPositions({ force: true, silent: true });
      const p = payload?.positions?.find((position) => position.position === position_address);
      if (p) {
        return {
          pnl_usd: p.pnl_usd,
          pnl_pct: p.pnl_pct,
          current_value_usd: p.total_value_usd,
          unclaimed_fee_usd: p.unclaimed_fees_usd,
          all_time_fees_usd: p.collected_fees_usd,
          fee_per_tvl_24h: p.fee_per_tvl_24h,
          in_range: p.in_range,
          lower_bin: p.lower_bin,
          upper_bin: p.upper_bin,
          active_bin: p.active_bin,
          age_minutes: p.age_minutes,
        };
      }
    } catch (error) {
      log("pnl_warn", `RPC PnL lookup failed; falling back to direct Meteora PnL path: ${error.message}`);
    }
  }
  try {
    const byAddress = await fetchDlmmPnlForPool(pool_address, walletAddress);
    const p = byAddress[position_address];
    if (!p) return { error: "Position not found in PnL API" };

    const solMode = config.management.solMode;
    const unclaimedValue = solMode
      ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
      : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd);
    const currentValue = solMode
      ? safeNum(p.unrealizedPnl?.balancesSol)
      : safeNum(p.unrealizedPnl?.balances);
    const reportedPnlPct = solMode
      ? maybeNum(p.pnlSolPctChange)
      : maybeNum(p.pnlPctChange);
    const derivedPnlPct = deriveOpenPnlPct(p, solMode);
    return {
      pnl_usd:           roundNum(solMode ? p.pnlSol : p.pnlUsd, 4),
      pnl_pct:           roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
      current_value_usd: roundNum(currentValue, 4),
      unclaimed_fee_usd: roundNum(unclaimedValue, 4),
      all_time_fees_usd: roundNum(solMode ? p.allTimeFees?.total?.sol : p.allTimeFees?.total?.usd, 4),
      fee_per_tvl_24h:   Math.round(parseFloat(p.feePerTvl24h || 0) * 100) / 100,
      in_range:    !p.isOutOfRange,
      lower_bin:   p.lowerBinId      ?? null,
      upper_bin:   p.upperBinId      ?? null,
      active_bin:  p.poolActiveBinId ?? null,
      age_minutes: p.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
    };
  } catch (error) {
    log("pnl_error", error.message);
    return { error: error.message };
  }
}

function safeNum(value) {
  const n = parseFloat(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function maybeNum(value) {
  if (value == null || value === "") return null;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Deterministic exit rules (no LLM).
 * Returns { action: "CLOSE", rule: string, reason: string } or null.
 */
export function getDeterministicCloseRule(position, mgmtConfig = {}) {
  const pnlPct = position.pnl_pct;
  const oorMinutes = position.minutes_out_of_range ?? 0;
  const ageMinutes = position.age_minutes ?? 0;
  const feePerTvl24h = position.fee_per_tvl_24h ?? 0;
  const unclaimedFees = position.unclaimed_fees_usd ?? 0;
  const minClaim = mgmtConfig.minClaimAmount ?? config.management.minClaimAmount;
  const oorBinsToClose = mgmtConfig.outOfRangeBinsToClose ?? config.management.outOfRangeBinsToClose;
  const oorWaitMinutes = mgmtConfig.outOfRangeWaitMinutes ?? config.management.outOfRangeWaitMinutes;
  const stopLossPct = mgmtConfig.stopLossPct ?? config.management.stopLossPct;
  const takeProfitPct = mgmtConfig.takeProfitPct ?? config.management.takeProfitPct;
  const minFeePerTvl24h = mgmtConfig.minFeePerTvl24h ?? config.management.minFeePerTvl24h;
  const minAgeBeforeYieldCheck = mgmtConfig.minAgeBeforeYieldCheck ?? config.management.minAgeBeforeYieldCheck;
  const exitRule3Enabled = mgmtConfig.exitRule3ConditionsEnabled ?? config.management.exitRule3ConditionsEnabled;

  // Exit Rule 3-Kondisi (opt-in): close when ANY of the three conditions is met
  if (exitRule3Enabled) {
    if (pnlPct != null && pnlPct >= takeProfitPct) {
      return { action: "CLOSE", rule: "exit_rule_3", reason: `PnL ${pnlPct.toFixed(2)}% ≥ takeProfitPct ${takeProfitPct}%` };
    }
    if (pnlPct != null && pnlPct <= stopLossPct) {
      return { action: "CLOSE", rule: "exit_rule_3", reason: `PnL ${pnlPct.toFixed(2)}% ≤ stopLossPct ${stopLossPct}%` };
    }
    if (oorMinutes >= oorWaitMinutes) {
      return { action: "CLOSE", rule: "exit_rule_3", reason: `OOR ${oorMinutes}m ≥ ${oorWaitMinutes}m` };
    }
  }

  // Default rules (trailing TP + hard SL + OOR timeout)
  if (oorMinutes >= oorWaitMinutes && oorBinsToClose > 0) {
    return { action: "CLOSE", rule: "oor_timeout", reason: `OOR ${oorMinutes}m ≥ ${oorWaitMinutes}m` };
  }
  if (pnlPct != null && pnlPct <= stopLossPct) {
    return { action: "CLOSE", rule: "stop_loss", reason: `PnL ${pnlPct.toFixed(2)}% ≤ stopLossPct ${stopLossPct}%` };
  }
  if (unclaimedFees >= minClaim) {
    return null; // claim, not close
  }
  if (ageMinutes >= minAgeBeforeYieldCheck && feePerTvl24h < minFeePerTvl24h) {
    return { action: "CLOSE", rule: "low_yield", reason: `fee/TVL 24h ${feePerTvl24h}% < ${minFeePerTvl24h}%` };
  }
  return null;
}

const PERFORMANCE_SIGNAL_FIELDS = [
  "organic_score",
  "fee_tvl_ratio",
  "volume",
  "mcap",
  "holder_count",
  "smart_wallets_present",
  "narrative_quality",
  "study_win_rate",
  "hive_consensus",
  "volatility",
];

/** Meteora program error 0x1774 = ExceededBinSlippageTolerance. */
export function isBinSlippageError(error) {
  return /0x1774|ExceededBinSlippage/i.test(String(error?.message ?? error));
}

/**
 * One rung of the 0x1774 retry ladder — pure and testable, no chain access.
 * attempt 1: re-anchor only (shift range to fresh active bin)
 * attempt 2: shrink bins ~15% (never below minBinsBelow)
 * attempt 3: fall back to spot, only when fee/TVL clears spotFeeTvlMin and
 *            the plan isn't already spot
 * Anything else: stop.
 */
export function planBinSlippageRetry(attempt, { strategy, binsBelow, binsAbove, feeTvlRatio, minBinsBelow, spotFeeTvlMin }) {
  if (attempt === 1) {
    return { action: "run", strategy, binsBelow, binsAbove, step: "shift range to fresh active bin" };
  }
  if (attempt === 2) {
    return {
      action: "run",
      strategy,
      binsBelow: Math.max(minBinsBelow, Math.round(binsBelow * 0.85)),
      binsAbove: binsAbove > 0 ? Math.round(binsAbove * 0.85) : 0,
      step: "shrink bins ~15%",
    };
  }
  if (attempt === 3) {
    const feeTvl = Number(feeTvlRatio);
    if (strategy === "spot" || !Number.isFinite(feeTvl) || feeTvl < spotFeeTvlMin) {
      return { action: "stop", reason: `spot fallback not eligible (fee/TVL ${feeTvlRatio ?? "?"} < ${spotFeeTvlMin})` };
    }
    return { action: "run", strategy: "spot", binsBelow, binsAbove, step: "fallback to spot" };
  }
  return { action: "stop", reason: "ladder exhausted" };
}

/** RPC settle window before reclaiming an emptied position account (partialClose uses the same). */
export const REBALANCE_SETTLE_DELAY_MS = 5000;

/** True when the planned range still fits the existing position account allocation. */
export function plannedRangeFitsAccount(minBinId, maxBinId, oldLower, oldUpper) {
  if (!Number.isFinite(minBinId) || !Number.isFinite(maxBinId)) return false;
  if (!Number.isFinite(oldLower) || !Number.isFinite(oldUpper)) return false;
  return minBinId >= oldLower && maxBinId <= oldUpper;
}

/**
 * Minimum free SOL required before a migrate rebalance (new position account + txs).
 * gasReserve must stay untouched; migrate rent + tx fees sit on top.
 */
export function minSolRequiredForRebalanceMigrate(mgmtConfig = {}, { isWide = false } = {}) {
  const gasReserve = Number(mgmtConfig.gasReserve ?? config.management.gasReserve ?? 0.2);
  const rentBuffer = Number(mgmtConfig.rebalanceMigrateRentBufferSol ?? config.management.rebalanceMigrateRentBufferSol ?? 0.1);
  const wideExtra = isWide ? Number(mgmtConfig.rebalanceMigrateWideRentExtraSol ?? config.management.rebalanceMigrateWideRentExtraSol ?? 0.05) : 0;
  const txBuffer = Number(mgmtConfig.rebalanceTxFeeBufferSol ?? config.management.rebalanceTxFeeBufferSol ?? 0.02);
  return gasReserve + rentBuffer + wideExtra + txBuffer;
}

/** Minimum free SOL for an in-place rebalance (re-add only — no new account rent). */
export function minSolRequiredForRebalanceInPlace(mgmtConfig = {}) {
  const gasReserve = Number(mgmtConfig.gasReserve ?? config.management.gasReserve ?? 0.2);
  const txBuffer = Number(mgmtConfig.rebalanceTxFeeBufferSol ?? config.management.rebalanceTxFeeBufferSol ?? 0.02);
  return gasReserve + txBuffer;
}

/**
 * Pure gate: is wallet SOL high enough for the rebalance path?
 * Returns { ok, required, path, reason }.
 */
export function checkRebalanceSolGate({ balanceSol, path, isWide, mgmtConfig } = {}) {
  const bal = Number(balanceSol);
  const p = path === "in_place" ? "in_place" : "migrate";
  const required = p === "in_place"
    ? minSolRequiredForRebalanceInPlace(mgmtConfig)
    : minSolRequiredForRebalanceMigrate(mgmtConfig, { isWide });
  if (!Number.isFinite(bal)) {
    return { ok: false, required, path: p, reason: "rebalance_skipped_insufficient_sol: balance unknown" };
  }
  if (bal < required) {
    return {
      ok: false,
      required,
      path: p,
      reason: `rebalance_skipped_insufficient_sol: have ${bal.toFixed(4)} SOL, need ${required.toFixed(4)} SOL (${p}${isWide ? ", wide" : ""})`,
    };
  }
  return { ok: true, required, path: p, reason: null };
}

/** Compact holder-audit block for deploy decision metrics, from staged screening signals. */
function buildHolderAuditSnapshot(snapshot) {
  if (!snapshot) return null;
  const audit = {
    top10_pct: snapshot.top10_pct ?? null,
    bot_pct: snapshot.bot_pct ?? null,
    bundler_pct: snapshot.bundler_pct ?? null,
    smart_degen_count: snapshot.smart_degen_count ?? null,
    organic_score: snapshot.organic_score ?? null,
    fresh_wallet_holder_pct: snapshot.fresh_wallet_holder_pct ?? null,
    bundled_wallet_holder_pct: snapshot.bundled_wallet_holder_pct ?? null,
  };
  return Object.values(audit).some((v) => v != null) ? audit : null;
}

function resolvePerformanceSignalSnapshot({ poolAddress, baseMint, tracked }) {
  const staged = config.darwin?.enabled
    ? getAndClearStagedSignals(poolAddress, baseMint)
    : null;
  const snapshot = {
    ...(staged || {}),
    ...(tracked?.signal_snapshot || {}),
  };

  if (baseMint && snapshot.base_mint == null) snapshot.base_mint = baseMint;
  for (const field of PERFORMANCE_SIGNAL_FIELDS) {
    if (snapshot[field] == null && tracked?.[field] != null) {
      snapshot[field] = tracked[field];
    }
  }

  return Object.values(snapshot).some((value) => value != null) ? snapshot : null;
}

function getClosedPnlValue(posEntry, solMode = false) {
  return solMode
    ? maybeNum(posEntry?.pnlSol) ?? maybeNum(posEntry?.pnl?.valueNative) ?? 0
    : maybeNum(posEntry?.pnlUsd) ?? maybeNum(posEntry?.pnl?.value) ?? 0;
}

function getClosedPnlPct(posEntry, solMode = false) {
  const reported = solMode
    ? maybeNum(posEntry?.pnlSolPctChange) ?? maybeNum(posEntry?.pnl?.percentNative)
    : maybeNum(posEntry?.pnlPctChange) ?? maybeNum(posEntry?.pnl?.percent);
  if (reported != null) return reported;

  const pnl = getClosedPnlValue(posEntry, solMode);
  const deposit = solMode
    ? maybeNum(posEntry?.allTimeDeposits?.total?.sol)
    : maybeNum(posEntry?.allTimeDeposits?.total?.usd);
  return deposit && deposit > 0 ? (pnl / deposit) * 100 : 0;
}

/**
 * Record positions that vanished on-chain without going through closePosition
 * (closed manually in the UI or by an external tool). Fetches the final PnL
 * from the Meteora closed-positions API and writes the close to the decision
 * log + pool memory so the trade isn't lost from the learning data.
 * Fire-and-forget from the getMyPositions sync path — never throws.
 */
async function handleExternalCloses(externallyClosed, walletAddress) {
  for (const pos of externallyClosed) {
    const reason = "closed externally (missing on-chain, manual close?)";
    let pnlUsd = null;
    let pnlPct = null;
    let feesUsd = pos.total_fees_claimed_usd || 0;
    const minutesHeld = pos.deployed_at
      ? Math.floor((Date.now() - new Date(pos.deployed_at).getTime()) / 60000)
      : null;

    try {
      if (pos.pool) {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${pos.pool}/pnl?user=${walletAddress}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 3; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find((p) => p.positionAddress === pos.position);
            if (posEntry) {
              pnlUsd = config.management.solMode ? getClosedPnlValue(posEntry, true) : safeNum(posEntry.pnlUsd);
              pnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
              break;
            }
          }
          if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
        }
      }
    } catch (e) {
      log("external_close_warn", `Final PnL fetch failed for ${pos.position.slice(0, 8)}: ${e.message}`);
    }

    try {
      if (pos.pool) {
        recordPoolDeploy(pos.pool, {
          pool_name: pos.pool_name || pos.pool.slice(0, 8),
          deployed_at: pos.deployed_at,
          closed_at: pos.closed_at,
          pnl_pct: pnlPct,
          pnl_usd: pnlUsd,
          fees_earned_usd: feesUsd || null,
          minutes_held: minutesHeld,
          close_reason: reason,
          strategy: pos.strategy,
          volatility: pos.volatility,
        });
      }
      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: pos.pool,
        pool_name: pos.pool_name || (pos.pool ? pos.pool.slice(0, 8) : null),
        position: pos.position,
        summary: pnlPct != null ? `Closed externally at ${pnlPct.toFixed(2)}%` : "Closed externally (PnL unknown)",
        reason,
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
          exit_signal_type: "manual_or_external",
        },
      });
      log("external_close", `Recorded external close for ${pos.pool_name || pos.position.slice(0, 8)}: PnL ${pnlPct != null ? pnlPct.toFixed(2) + "%" : "unknown"}`);
    } catch (e) {
      log("external_close_warn", `Recording external close failed for ${pos.position.slice(0, 8)}: ${e.message}`);
    }
  }
}

function deriveOpenPnlPct(binData, solMode = false) {
  if (!binData) return null;

  const deposit = solMode
    ? safeNum(binData.allTimeDeposits?.total?.sol)
    : safeNum(binData.allTimeDeposits?.total?.usd);
  if (deposit <= 0) return null;

  const balances = solMode
    ? safeNum(binData.unrealizedPnl?.balancesSol)
    : safeNum(binData.unrealizedPnl?.balances);
  const unclaimedFees = solMode
    ? safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
    : safeNum(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd);
  const withdrawals = solMode
    ? safeNum(binData.allTimeWithdrawals?.total?.sol)
    : safeNum(binData.allTimeWithdrawals?.total?.usd);
  const fees = solMode
    ? safeNum(binData.allTimeFees?.total?.sol)
    : safeNum(binData.allTimeFees?.total?.usd);

  const pnl = balances + unclaimedFees + withdrawals + fees - deposit;
  return (pnl / deposit) * 100;
}

function deriveLpAgentPnlPct(lpData, solMode = false) {
  if (!lpData) return null;
  const deposit = solMode ? safeNum(lpData.inputNative) : safeNum(lpData.inputValue);
  if (deposit <= 0) return null;

  const currentValue = solMode ? safeNum(lpData.valueNative) : safeNum(lpData.value);
  const unclaimedFees = solMode ? safeNum(lpData.unCollectedFeeNative) : safeNum(lpData.unCollectedFee);
  const pnl = currentValue + unclaimedFees - deposit;
  return (pnl / deposit) * 100;
}

async function fetchRawOpenPositionsFromMeridian({ walletAddress, agentId }) {
  const search = new URLSearchParams({
    owner: walletAddress,
    agentId: agentId || "agent-local",
  });
  const payload = await agentMeridianJson(`/positions/open/raw?${search.toString()}`, {
    headers: getAgentMeridianHeaders(),
    retry: {
      maxElapsedMs: 30_000,
      perAttemptTimeoutMs: 10_000,
    },
  });
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const byPosition = {};
  for (const row of rows) {
    const addr = row?.position || row?.id || row?.tokenId;
    if (addr) byPosition[addr] = row;
  }
  return {
    ...payload,
    data: rows,
    byPosition,
  };
}

// ─── Get My Positions ──────────────────────────────────────────
export async function getMyPositions({ force = false, silent = false, wallet_address = null } = {}) {
  let walletOverride = null;
  try {
    walletOverride = wallet_address ? new PublicKey(wallet_address).toString() : null;
  } catch {
    return { wallet: wallet_address || null, total_positions: 0, positions: [], error: "Invalid wallet address" };
  }

  const useLocalWallet = !walletOverride;
  if (useLocalWallet && !force && _positionsCache && Date.now() - _positionsCacheAt < POSITIONS_CACHE_TTL) {
    return _positionsCache;
  }
  if (useLocalWallet && _positionsInflight) return _positionsInflight;

  let walletAddress;
  try {
    walletAddress = walletOverride || getWallet().publicKey.toString();
  } catch {
    return { wallet: null, total_positions: 0, positions: [], error: "Wallet not configured" };
  }

  const loadPositions = async () => { try {
    // ── Primary path: public infra (on-chain RPC + Jupiter + Meteora deposits) ──
    // No LPAgent / agentmeridian dependency, so the poller runs aggressively on
    // fully public resources. Falls through to the Meteora-API path on any error.
    if (config.pnl.source === "rpc") {
      try {
        if (!silent) log("positions", `Computing PnL from RPC (${config.pnl.rpcUrl})...`);
        const rpcResult = await computePositions(walletAddress);
        if (useLocalWallet) {
          const externallyClosed = syncOpenPositions(rpcResult.positions.map((p) => p.position));
          if (externallyClosed?.length) {
            handleExternalCloses(externallyClosed, walletAddress).catch((e) => log("external_close_warn", e.message));
          }
          _positionsCache = rpcResult;
          _positionsCacheAt = Date.now();
        }
        return rpcResult;
      } catch (error) {
        log("positions_warn", `RPC PnL path failed; falling back to Meteora portfolio API: ${error.message}`);
      }
    }

    // ── Fallback path: Meteora portfolio + /pnl APIs (no LPAgent) ──
    if (!silent) log("positions", "Fetching portfolio via Meteora portfolio API...");
    const portfolioUrl = `https://dlmm.datapi.meteora.ag/portfolio/open?user=${walletAddress}`;
    const res = await fetch(portfolioUrl);
    if (!res.ok) throw new Error(`Portfolio API ${res.status}: ${await res.text().catch(() => "")}`);
    const portfolio = await res.json();

    const pools = portfolio.pools || [];
    log("positions", `Found ${pools.length} pool(s) with open positions`);

    // Fetch bin data (lowerBinId, upperBinId, poolActiveBinId) for all pools in parallel
    // Needed for rules 3 & 4 (active_bin vs upper_bin comparison)
    const binDataByPool = {};
    const pnlMaps = await Promise.all(pools.map(pool => fetchDlmmPnlForPool(pool.poolAddress, walletAddress)));
    pools.forEach((pool, i) => { binDataByPool[pool.poolAddress] = pnlMaps[i]; });
    const lpAgentByPosition = {}; // LPAgent removed — Meteora binData only

    const positions = [];
    for (const pool of pools) {
      for (const positionAddress of (pool.listPositions || [])) {
        const tracked = getTrackedPosition(positionAddress);
        const isOOR = pool.outOfRange || pool.positionsOutOfRange?.includes(positionAddress);

        if (isOOR) markOutOfRange(positionAddress);
        else markInRange(positionAddress);

        // Bin data: from supplemental PnL call (OOR) or tracked state (in-range)
        const binData = binDataByPool[pool.poolAddress]?.[positionAddress];
        if (!binData) {
          log("positions_warn", `PnL API missing data for ${positionAddress.slice(0, 8)} in pool ${pool.poolAddress.slice(0, 8)} — using portfolio only for open-position discovery`);
        }
        const lowerBin  = binData?.lowerBinId      ?? tracked?.bin_range?.min ?? null;
        const upperBin  = binData?.upperBinId      ?? tracked?.bin_range?.max ?? null;
        const activeBin = binData?.poolActiveBinId ?? tracked?.bin_range?.active ?? null;
        const lpData = lpAgentByPosition[positionAddress] || null;

        const ageFromState = tracked?.deployed_at
          ? Math.floor((Date.now() - new Date(tracked.deployed_at).getTime()) / 60000)
          : null;
        const reportedPnlPct = lpData
          ? parseFloat(config.management.solMode ? (lpData.pnl?.percentNative || 0) : (lpData.pnl?.percent || 0))
          : binData
            ? parseFloat(config.management.solMode ? (binData.pnlSolPctChange || 0) : (binData.pnlPctChange || 0))
            : null;
        const derivedPnlPct = lpData
          ? deriveLpAgentPnlPct(lpData, config.management.solMode)
          : binData
            ? deriveOpenPnlPct(binData, config.management.solMode)
            : null;
        const pnlPctDiff = reportedPnlPct != null && derivedPnlPct != null
          ? Math.abs(reportedPnlPct - derivedPnlPct)
          : null;
        // Gate PnL rules ONLY when the tick is genuinely unpriceable (no real number
        // from either method — e.g. missing deposits / data outage). Reported-vs-derived
        // divergence is normal noise on volatile pools, so it is logged but NOT gated —
        // gating on it froze all exits (stop-loss/trailing/close) and stranded positions.
        const pnlPctSuspicious = reportedPnlPct == null && derivedPnlPct == null;
        if (pnlPctSuspicious) {
          log("positions_warn", `Unpriceable pnl_pct for ${positionAddress.slice(0, 8)}: no valid reported/derived value this tick — PnL rules paused`);
        } else if (pnlPctDiff != null && pnlPctDiff > (config.management.pnlSanityMaxDiffPct ?? 5)) {
          // Informational only — does not gate rules.
          log("positions_warn", `pnl_pct divergence for ${positionAddress.slice(0, 8)}: reported=${reportedPnlPct.toFixed(2)} derived=${derivedPnlPct.toFixed(2)} diff=${pnlPctDiff.toFixed(2)} (informational)`);
        }

        positions.push({
          position:           positionAddress,
          pool:               pool.poolAddress,
          pair:               tracked?.pool_name || `${pool.tokenX}/${pool.tokenY}`,
          base_mint:          pool.tokenXMint,
          lower_bin:          lowerBin,
          upper_bin:          upperBin,
          active_bin:         activeBin,
          in_range:           binData ? !binData.isOutOfRange : !isOOR,
          unclaimed_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.unCollectedFeeNative)
                  : safeNum(lpData.unCollectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.amountSol || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.amountSol || 0)
                  : parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)
              ) * 10000) / 10000
            : null,
          total_value_usd:    lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.valueNative)
                  : safeNum(lpData.value)
              ) * 10000) / 10000
            : binData
            ? Math.round((
                config.management.solMode
                  ? parseFloat(binData.unrealizedPnl?.balancesSol || 0)
                  : parseFloat(binData.unrealizedPnl?.balances || 0)
              ) * 10000) / 10000
            : null,
          // Always-USD fields for internal accounting and lesson recording.
          total_value_true_usd: lpData
            ? Math.round(safeNum(lpData.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.unrealizedPnl?.balances || 0) * 10000) / 10000
            : null,
          collected_fees_usd: lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.collectedFeeNative)
                  : safeNum(lpData.collectedFee)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.allTimeFees?.total?.sol || 0) : (binData.allTimeFees?.total?.usd || 0)) * 10000) / 10000
            : null,
          collected_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.collectedFee) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.allTimeFees?.total?.usd || 0) * 10000) / 10000
            : null,
          pnl_usd:            lpData
            ? Math.round((
                config.management.solMode
                  ? safeNum(lpData.pnl?.valueNative)
                  : safeNum(lpData.pnl?.value)
              ) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(config.management.solMode ? (binData.pnlSol || 0) : (binData.pnlUsd || 0)) * 10000) / 10000
            : null,
          pnl_true_usd:       lpData
            ? Math.round(safeNum(lpData.pnl?.value) * 10000) / 10000
            : binData
            ? Math.round(parseFloat(binData.pnlUsd || 0) * 10000) / 10000
            : null,
          pnl_pct:            (lpData || binData)
            ? Math.round(reportedPnlPct * 100) / 100
            : null,
          pnl_pct_derived:    derivedPnlPct != null ? Math.round(derivedPnlPct * 100) / 100 : null,
          pnl_pct_diff:       pnlPctDiff != null ? Math.round(pnlPctDiff * 100) / 100 : null,
          pnl_pct_suspicious: !!pnlPctSuspicious,
          unclaimed_fees_true_usd: lpData
            ? Math.round(safeNum(lpData.unCollectedFee) * 10000) / 10000
            : binData
            ? Math.round((parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenX?.usd || 0) + parseFloat(binData.unrealizedPnl?.unclaimedFeeTokenY?.usd || 0)) * 10000) / 10000
            : null,
          fee_per_tvl_24h:    binData
            ? Math.round(parseFloat(binData.feePerTvl24h || 0) * 100) / 100
            : null,
          age_minutes:        binData?.createdAt ? Math.floor((Date.now() - binData.createdAt * 1000) / 60000) : ageFromState,
          minutes_out_of_range: minutesOutOfRange(positionAddress),
          instruction:        tracked?.instruction ?? null,
        });
      }
    }

    const result = {
      wallet: walletAddress,
      total_positions: positions.length,
      positions,
      source: "meteora",
    };
    if (useLocalWallet) {
      const externallyClosed = syncOpenPositions(positions.map(p => p.position));
      if (externallyClosed?.length) {
        handleExternalCloses(externallyClosed, walletAddress).catch((e) => log("external_close_warn", e.message));
      }
      _positionsCache = result;
      _positionsCacheAt = Date.now();
    }
    return result;
  } catch (error) {
    log("positions_error", `Portfolio fetch failed: ${error.stack || error.message}`);
    return { wallet: walletAddress, total_positions: 0, positions: [], error: error.message };
  } finally {
    if (useLocalWallet) _positionsInflight = null;
  }
  };

  if (useLocalWallet) {
    _positionsInflight = loadPositions();
    return _positionsInflight;
  }

  return loadPositions();
}

// ─── Get Positions for Any Wallet ─────────────────────────────
export async function getWalletPositions({ wallet_address }) {
  try {
    const DLMM_PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");

    const accounts = await getConnection().getProgramAccounts(DLMM_PROGRAM, {
      filters: [{ memcmp: { offset: 40, bytes: new PublicKey(wallet_address).toBase58() } }],
    });

    if (accounts.length === 0) {
      return { wallet: wallet_address, total_positions: 0, positions: [] };
    }

    const raw = accounts.map((acc) => ({
      position: acc.pubkey.toBase58(),
      pool: new PublicKey(acc.account.data.slice(8, 40)).toBase58(),
    }));

    // Enrich with PnL API
    const uniquePools = [...new Set(raw.map((r) => r.pool))];
    const pnlMaps = await Promise.all(uniquePools.map((pool) => fetchDlmmPnlForPool(pool, wallet_address)));
    const pnlByPool = {};
    uniquePools.forEach((pool, i) => { pnlByPool[pool] = pnlMaps[i]; });

    const positions = raw.map((r) => {
      const p = pnlByPool[r.pool]?.[r.position] || null;
      const solMode = config.management.solMode;
      const unclaimedValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.amountSol) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.amountSol)
          : safeNum(p.unrealizedPnl?.unclaimedFeeTokenX?.usd) + safeNum(p.unrealizedPnl?.unclaimedFeeTokenY?.usd)
        : 0;
      const currentValue = p
        ? solMode
          ? safeNum(p.unrealizedPnl?.balancesSol)
          : safeNum(p.unrealizedPnl?.balances)
        : 0;
      const reportedPnlPct = p
        ? solMode
          ? maybeNum(p.pnlSolPctChange)
          : maybeNum(p.pnlPctChange)
        : null;
      const derivedPnlPct = p ? deriveOpenPnlPct(p, solMode) : null;

      return {
        position:           r.position,
        pool:               r.pool,
        lower_bin:          p?.lowerBinId      ?? null,
        upper_bin:          p?.upperBinId      ?? null,
        active_bin:         p?.poolActiveBinId ?? null,
        in_range:           p ? !p.isOutOfRange : null,
        unclaimed_fees_usd: roundNum(unclaimedValue, 4),
        total_value_usd:    roundNum(currentValue, 4),
        pnl_usd:            roundNum(p ? (solMode ? p.pnlSol : p.pnlUsd) : 0, 4),
        pnl_pct:            roundNum(reportedPnlPct ?? derivedPnlPct ?? 0, 2),
        age_minutes:        p?.createdAt ? Math.floor((Date.now() - p.createdAt * 1000) / 60000) : null,
      };
    });

    return { wallet: wallet_address, total_positions: positions.length, positions };
  } catch (error) {
    log("wallet_positions_error", error.message);
    return { wallet: wallet_address, total_positions: 0, positions: [], error: error.message };
  }
}

// ─── Search Pools by Query ─────────────────────────────────────
export async function searchPools({ query, limit = 10 }) {
  const url = `https://dlmm.datapi.meteora.ag/pools?query=${encodeURIComponent(query)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool search API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const pools = (Array.isArray(data) ? data : data.data || []).slice(0, limit);
  return {
    query,
    total: pools.length,
    pools: pools.map((p) => ({
      pool: p.address || p.pool_address,
      name: p.name,
      bin_step: p.bin_step ?? p.dlmm_params?.bin_step,
      fee_pct: p.base_fee_percentage ?? p.fee_pct,
      tvl: p.liquidity,
      volume_24h: p.trade_volume_24h,
      token_x: { symbol: p.mint_x_symbol ?? p.token_x?.symbol, mint: p.mint_x ?? p.token_x?.address },
      token_y: { symbol: p.mint_y_symbol ?? p.token_y?.symbol, mint: p.mint_y ?? p.token_y?.address },
    })),
  };
}

// ─── Claim Fees ────────────────────────────────────────────────
export async function claimFees({ position_address }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_claim: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed — fees were claimed during close" };
  }

  try {
    log("claim", `Claiming fees for position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionData = await pool.getPosition(new PublicKey(position_address));
    const txs = await pool.claimSwapFee({
      owner: wallet.publicKey,
      position: positionData,
    });

    if (!txs || txs.length === 0) {
      return { success: false, error: "No fees to claim — transaction is empty" };
    }

    const txHashes = [];
    for (const tx of txs) {
      const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
      txHashes.push(txHash);
    }
    log("claim", `SUCCESS txs: ${txHashes.join(", ")}`);
    _positionsCacheAt = 0; // invalidate cache after claim
    recordClaim(position_address);

    return { success: true, position: position_address, txs: txHashes, base_mint: pool.lbPair.tokenXMint.toString() };
  } catch (error) {
    log("claim_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Partial Close (DCA-out) ───────────────────────────────────
/**
 * One-time partial take-profit: claim fees, then remove close_pct% of liquidity
 * WITHOUT closing the position account. The remaining liquidity keeps running
 * under the existing SL/trailing management. Marks partial_tp_done in state so
 * it can never fire twice for the same position. Local SDK path only (deploys
 * already use it regardless of relay mode).
 */
export async function partialClosePosition({ position_address, close_pct = 50, reason }) {
  position_address = normalizeMint(position_address);
  const pct = Math.min(Math.max(Number(close_pct) || 50, 1), 99);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_partial_close: position_address, close_pct: pct, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) {
    return { success: false, error: "Position already closed" };
  }
  if (tracked?.partial_tp_done) {
    return { success: false, error: "Partial TP already executed for this position" };
  }

  recordPartialTpAttempt(position_address);
  try {
    log("partial_close", `Partial close ${pct}% of ${position_address}: ${reason || "partial take profit"}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);
    const positionPubKey = new PublicKey(position_address);
    const baseMint = pool.lbPair.tokenXMint.toString();

    // ─── Step 1: Claim fees (realize earnings before trimming) ─
    const claimTxHashes = [];
    try {
      const positionData = await pool.getPosition(positionPubKey);
      const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: positionData });
      for (const tx of claimTxs || []) {
        claimTxHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
      }
      if (claimTxHashes.length) {
        log("partial_close", `Step 1 OK (claim): ${claimTxHashes.join(", ")}`);
        recordClaim(position_address);
      }
    } catch (e) {
      log("partial_close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove pct% of liquidity, keep account open ──
    const positionForRemove = await pool.getPosition(positionPubKey);
    const processed = positionForRemove?.positionData;
    const fromBinId = processed?.lowerBinId ?? tracked?.bin_range?.min ?? -887272;
    const toBinId = processed?.upperBinId ?? tracked?.bin_range?.max ?? 887272;

    const removeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId,
      toBinId,
      bps: new BN(Math.round(pct * 100)),
      shouldClaimAndClose: false,
    });
    const removeTxHashes = [];
    for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
      removeTxHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
    }
    log("partial_close", `Step 2 OK (removed ${pct}%): ${removeTxHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before the caller's auto-swap
    await new Promise((r) => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    markPartialTpDone(position_address, `removed ${pct}% liquidity — ${reason || "partial take profit"}`);
    appendDecision({
      type: "partial_close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: tracked?.pool_name || poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: `Partial TP: removed ${pct}% liquidity, position stays open`,
      reason: reason || "partial take profit",
      metrics: {
        exit_signal_type: "partial_tp",
        closed_pct: pct,
      },
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: tracked?.pool_name || poolMeta.name || null,
      close_pct: pct,
      claim_txs: claimTxHashes,
      remove_txs: removeTxHashes,
      base_mint: baseMint,
    };
  } catch (error) {
    log("partial_close_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Liquidity primitives (used by cli.js + rebalance) ─────────

async function resolveStrategyType(strategy) {
  const { StrategyType } = await getDLMM();
  const map = { spot: StrategyType.Spot, curve: StrategyType.Curve, bid_ask: StrategyType.BidAsk };
  const type = map[strategy];
  if (type === undefined) throw new Error(`Invalid strategy: ${strategy}. Use spot, curve, or bid_ask.`);
  return type;
}

/**
 * Remove liquidity from an existing position without closing the account.
 * bps 10000 = 100%. Returns the pre-withdraw X/Y amounts (raw lamport strings)
 * so callers (rebalance) know the re-add budget.
 */
export async function withdrawLiquidity({ position_address, pool_address, bps = 10000, claim_fees = true }) {
  position_address = normalizeMint(position_address);
  const clampedBps = Math.min(Math.max(Math.round(Number(bps) || 10000), 1), 10000);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_withdraw: position_address, bps: clampedBps, message: "DRY RUN — no transaction sent" };
  }
  try {
    const wallet = getWallet();
    const poolAddress = pool_address || (await lookupPoolForPosition(position_address, wallet.publicKey.toString()));
    poolCache.delete(String(poolAddress));
    const pool = await getPool(poolAddress);
    const positionPubKey = new PublicKey(position_address);

    const claimTxHashes = [];
    if (claim_fees) {
      try {
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({ owner: wallet.publicKey, position: positionData });
        for (const tx of claimTxs || []) {
          claimTxHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
        }
        if (claimTxHashes.length) recordClaim(position_address);
      } catch (e) {
        log("withdraw_warn", `Claim before withdraw failed or nothing to claim: ${e.message}`);
      }
    }

    const positionForRemove = await pool.getPosition(positionPubKey);
    const processed = positionForRemove?.positionData;
    const fromBinId = processed?.lowerBinId ?? -887272;
    const toBinId = processed?.upperBinId ?? 887272;
    const withdrawnX = String(processed?.totalXAmount ?? "0");
    const withdrawnY = String(processed?.totalYAmount ?? "0");

    const removeTx = await pool.removeLiquidity({
      user: wallet.publicKey,
      position: positionPubKey,
      fromBinId,
      toBinId,
      bps: new BN(clampedBps),
      shouldClaimAndClose: false,
    });
    const removeTxHashes = [];
    for (const tx of Array.isArray(removeTx) ? removeTx : [removeTx]) {
      removeTxHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
    }
    _positionsCacheAt = 0;
    log("withdraw", `Removed ${clampedBps / 100}% liquidity from ${position_address.slice(0, 8)}: ${removeTxHashes.join(", ")}`);

    return {
      success: true,
      position: position_address,
      pool: String(poolAddress),
      bps: clampedBps,
      claim_txs: claimTxHashes,
      remove_txs: removeTxHashes,
      withdrawn_x: withdrawnX,
      withdrawn_y: withdrawnY,
      lower_bin: fromBinId,
      upper_bin: toBinId,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error) {
    log("withdraw_error", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Add liquidity to an EXISTING position at its current bin range.
 * amount_x / amount_y in human units; amount_x_lamports / amount_y_lamports
 * (BN-able) override them for exact re-adds.
 */
export async function addLiquidity({
  position_address,
  pool_address,
  amount_x = 0,
  amount_y = 0,
  strategy = "spot",
  single_sided_x = false,
  amount_x_lamports = null,
  amount_y_lamports = null,
}) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_add_to: position_address, amount_x, amount_y, strategy, message: "DRY RUN — no transaction sent" };
  }
  try {
    const wallet = getWallet();
    const poolAddress = pool_address || (await lookupPoolForPosition(position_address, wallet.publicKey.toString()));
    poolCache.delete(String(poolAddress));
    const pool = await getPool(poolAddress);
    const positionPubKey = new PublicKey(position_address);
    const strategyType = await resolveStrategyType(strategy);

    const existing = await pool.getPosition(positionPubKey);
    const minBinId = existing?.positionData?.lowerBinId;
    const maxBinId = existing?.positionData?.upperBinId;
    if (minBinId == null || maxBinId == null) throw new Error("Position bin range unavailable");

    let totalXAmount = new BN(0);
    if (amount_x_lamports != null) {
      totalXAmount = new BN(String(amount_x_lamports));
    } else if (amount_x > 0) {
      const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
      const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
      totalXAmount = new BN(Math.floor(amount_x * Math.pow(10, decimals)));
    }
    let totalYAmount = amount_y_lamports != null
      ? new BN(String(amount_y_lamports))
      : new BN(Math.floor((single_sided_x ? 0 : amount_y) * 1e9));

    const isWide = maxBinId - minBinId + 1 > 69;
    const txHashes = [];
    const params = {
      positionPubKey,
      user: wallet.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId, maxBinId, strategyType },
      slippage: 10,
    };
    if (isWide) {
      const txs = await pool.addLiquidityByStrategyChunkable(params);
      for (const tx of Array.isArray(txs) ? txs : [txs]) {
        txHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
      }
    } else {
      const tx = await pool.addLiquidityByStrategy({ ...params, slippage: 1000 });
      for (const t of Array.isArray(tx) ? tx : [tx]) {
        txHashes.push(await sendAndConfirmTransaction(getConnection(), t, [wallet]));
      }
    }
    _positionsCacheAt = 0;
    log("add_liquidity", `Added liquidity to ${position_address.slice(0, 8)} (${strategy}, bins ${minBinId}→${maxBinId}): ${txHashes.join(", ")}`);
    return { success: true, position: position_address, pool: String(poolAddress), txs: txHashes, min_bin: minBinId, max_bin: maxBinId, strategy };
  } catch (error) {
    log("add_liquidity_error", error.message);
    return { success: false, error: error.message };
  }
}

/** Best-effort reclaim of an emptied position account after RPC settle. */
async function reclaimEmptyPositionAccount(pool, wallet, position_address, { delayMs = REBALANCE_SETTLE_DELAY_MS, label = "rebalance" } = {}) {
  if (delayMs > 0) {
    await new Promise((r) => setTimeout(r, delayMs));
  }
  try {
    const orphan = await pool.getPosition(new PublicKey(position_address));
    const closeTx = await pool.closePositionIfEmpty({ owner: wallet.publicKey, position: orphan });
    if (closeTx) {
      const hash = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
      log(label, `Reclaimed empty position account ${position_address.slice(0, 8)} (settle ${delayMs}ms): ${hash}`);
      return { success: true, tx: hash };
    }
  } catch (e) {
    log(`${label}_warn`, `Could not reclaim empty account ${position_address.slice(0, 8)}: ${e.message}`);
  }
  return { success: false };
}

// ─── Rebalance (POWER MODE) ────────────────────────────────────

/**
 * Reposition an open position to a fresh range from a position-router plan:
 * claim → remove 100% (account kept) → re-add at the new range.
 *
 * DLMM position accounts have a FIXED bin allocation set at creation, so a
 * range that still fits the old account re-adds in place ("in_place" path);
 * a shifted range migrates to a new account and reclaims the old rent
 * ("migrate" path — the common case for shift_up / reseed_below).
 *
 * Fail-open: if the re-add fails after the 0x1774 ladder, the withdrawn funds
 * stay in the wallet, the empty account is reclaimed, and the position is
 * marked closed with reason "rebalance failed" — the screener redeploys later.
 */
export async function rebalancePosition({ position_address, plan, reason }) {
  position_address = normalizeMint(position_address);
  if (!plan || (plan.bins_below == null && plan.bins_above == null)) {
    return { success: false, error: "rebalance plan with bins_below/bins_above required" };
  }
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_rebalance: position_address,
      rebalance_type: plan.rebalance_type,
      strategy: plan.strategy,
      bins: `${plan.bins_below}/${plan.bins_above}`,
      message: "DRY RUN — no transaction sent",
    };
  }

  const tracked = getTrackedPosition(position_address);
  if (tracked?.closed) return { success: false, error: "Position already closed" };

  try {
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    poolCache.delete(String(poolAddress));
    const pool = await getPool(poolAddress);
    try {
      await pool.refetchStates(); // 0x1774 lesson: never anchor to a stale active bin
    } catch (e) {
      log("rebalance_warn", `refetchStates failed (${e.message}) — using getActiveBin only`);
    }

    // Pre-flight: assess migrate vs in_place and verify SOL BEFORE withdraw.
    const freshBin = await pool.getActiveBin();
    let preBinsBelow = Math.max(0, Number(plan.bins_below) || 0);
    let preBinsAbove = Math.max(0, Number(plan.bins_above) || 0);
    const preMinBinId = freshBin.binId - preBinsBelow;
    const preMaxBinId = freshBin.binId + preBinsAbove;
    const preIsWide = preMaxBinId - preMinBinId + 1 > 69;

    let accountLower = tracked?.bin_range?.min;
    let accountUpper = tracked?.bin_range?.max;
    try {
      const existing = await pool.getPosition(new PublicKey(position_address));
      const lower = existing?.positionData?.lowerBinId;
      const upper = existing?.positionData?.upperBinId;
      if (Number.isFinite(lower) && Number.isFinite(upper)) {
        accountLower = lower;
        accountUpper = upper;
      }
    } catch (e) {
      log("rebalance_warn", `Could not read on-chain bin range for pre-flight (${e.message}) — using tracked range`);
    }

    const prePath = plannedRangeFitsAccount(preMinBinId, preMaxBinId, accountLower, accountUpper) ? "in_place" : "migrate";
    const balance = await getWalletBalances().catch(() => null);
    const solGate = checkRebalanceSolGate({
      balanceSol: balance?.sol,
      path: prePath,
      isWide: preIsWide,
      mgmtConfig: config.management,
    });
    if (!solGate.ok) {
      log("rebalance", `Skipped (${prePath}): ${solGate.reason}`);
      appendDecision({
        type: "skip",
        actor: "MANAGER",
        pool: String(poolAddress),
        pool_name: tracked?.pool_name || poolMeta.name || String(poolAddress).slice(0, 8),
        position: position_address,
        summary: "Rebalance skipped — insufficient SOL for safe migrate",
        reason: solGate.reason,
        metrics: {
          rebalance_type: plan.rebalance_type ?? null,
          rebalance_path_planned: prePath,
          balance_sol: balance?.sol ?? null,
          sol_required: solGate.required,
          planned_bins: preBinsBelow + preBinsAbove,
          planned_wide: preIsWide,
        },
      });
      return { success: false, blocked: true, error: solGate.reason, rebalance_path_planned: prePath };
    }

    // Cooldown stamp only once pre-flight passes — skips must not burn the backoff
    recordRebalanceAttempt(position_address);

    // Step 1+2: claim + remove 100%, capture the re-add budget
    const withdrawn = await withdrawLiquidity({ position_address, pool_address: String(poolAddress), bps: 10000, claim_fees: true });
    if (!withdrawn.success) {
      return { success: false, error: `Withdraw failed: ${withdrawn.error}` };
    }
    const oldLower = withdrawn.lower_bin;
    const oldUpper = withdrawn.upper_bin;
    let budgetX = new BN(withdrawn.withdrawn_x || "0");
    let budgetY = new BN(withdrawn.withdrawn_y || "0");

    // Token-heavy after a dump-through: give the withdrawn token an ask side
    // to sell into the bounce (single_sided_reseed doctrine).
    let binsBelow = Math.max(0, Number(plan.bins_below) || 0);
    let binsAbove = Math.max(0, Number(plan.bins_above) || 0);
    if (budgetX.gt(new BN(0)) && binsAbove === 0) {
      binsAbove = Math.max(1, Math.ceil(binsBelow / 3));
      log("rebalance", `Withdrawn base-token budget > 0 with no ask side — extending ${binsAbove} bins above for the bounce`);
    }

    const spotFeeTvlMin = Number(config.autoStrategy?.spotFeeTvlMin ?? 2);
    let runStrategy = plan.strategy || "bid_ask";
    let runBinsBelow = binsBelow;
    let runBinsAbove = binsAbove;
    let added = null;
    let lastError = null;

    for (let attempt = 0; attempt <= 3; attempt++) {
      if (attempt > 0) {
        const step = planBinSlippageRetry(attempt, {
          strategy: runStrategy,
          binsBelow: runBinsBelow,
          binsAbove: runBinsAbove,
          feeTvlRatio: plan.fee_tvl_ratio ?? null,
          minBinsBelow: config.strategy.minBinsBelow,
          spotFeeTvlMin,
        });
        if (step.action === "stop") {
          log("rebalance", `0x1774 ladder exhausted — ${step.reason}`);
          break;
        }
        runStrategy = step.strategy;
        runBinsBelow = step.binsBelow;
        runBinsAbove = step.binsAbove;
        try { await pool.refetchStates(); } catch { /* fresh bin below still re-fetched */ }
      }

      const freshBin = await pool.getActiveBin();
      const minBinId = freshBin.binId - runBinsBelow;
      const maxBinId = freshBin.binId + runBinsAbove;
      const strategyType = await resolveStrategyType(runStrategy);
      const fitsOldAccount = minBinId >= oldLower && maxBinId <= oldUpper;
      const isWide = maxBinId - minBinId + 1 > 69;

      try {
        await assertRangeDoesNotRequireBinArrayInitialization(pool, minBinId, maxBinId);
        const txHashes = [];
        let newPositionAddress = position_address;
        let path;

        if (fitsOldAccount) {
          // In-place: same account, new distribution (convert_to_spot case)
          path = "in_place";
          const params = {
            positionPubKey: new PublicKey(position_address),
            user: wallet.publicKey,
            totalXAmount: budgetX,
            totalYAmount: budgetY,
            strategy: { minBinId, maxBinId, strategyType },
          };
          const txs = isWide
            ? await pool.addLiquidityByStrategyChunkable({ ...params, slippage: 10 })
            : await pool.addLiquidityByStrategy({ ...params, slippage: 1000 });
          for (const tx of Array.isArray(txs) ? txs : [txs]) {
            txHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
          }
        } else {
          // Migrate: new account at the shifted range, then reclaim old rent
          path = "migrate";
          const newPosition = Keypair.generate();
          newPositionAddress = newPosition.publicKey.toString();
          if (isWide) {
            const createTxs = await pool.createExtendedEmptyPosition(minBinId, maxBinId, newPosition.publicKey, wallet.publicKey);
            const createTxArray = Array.isArray(createTxs) ? createTxs : [createTxs];
            for (let i = 0; i < createTxArray.length; i++) {
              txHashes.push(await sendAndConfirmTransaction(getConnection(), createTxArray[i], i === 0 ? [wallet, newPosition] : [wallet]));
            }
            const addTxs = await pool.addLiquidityByStrategyChunkable({
              positionPubKey: newPosition.publicKey,
              user: wallet.publicKey,
              totalXAmount: budgetX,
              totalYAmount: budgetY,
              strategy: { minBinId, maxBinId, strategyType },
              slippage: 10,
            });
            for (const tx of Array.isArray(addTxs) ? addTxs : [addTxs]) {
              txHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet]));
            }
          } else {
            const tx = await pool.initializePositionAndAddLiquidityByStrategy({
              positionPubKey: newPosition.publicKey,
              user: wallet.publicKey,
              totalXAmount: budgetX,
              totalYAmount: budgetY,
              strategy: { minBinId, maxBinId, strategyType },
              slippage: 1000,
            });
            txHashes.push(await sendAndConfirmTransaction(getConnection(), tx, [wallet, newPosition]));
          }
          // Old account is now empty — wait for RPC settle, then reclaim rent
          const reclaimed = await reclaimEmptyPositionAccount(pool, wallet, position_address);
          if (reclaimed.tx) txHashes.push(reclaimed.tx);
        }

        added = {
          txHashes,
          path,
          newPositionAddress,
          minBinId,
          maxBinId,
          activeBinId: freshBin.binId,
          strategy: runStrategy,
          binsBelow: runBinsBelow,
          binsAbove: runBinsAbove,
          retries: attempt,
        };
        break;
      } catch (error) {
        lastError = error;
        if (!isBinSlippageError(error)) break;
        log("rebalance", `Bin slippage (0x1774) on rebalance attempt ${attempt}: ${error.message}`);
      }
    }

    _positionsCacheAt = 0;

    if (!added) {
      // Fail-open: withdrawn funds are in the wallet; reclaim the empty
      // account and hand the pool back to the screener.
      const failMsg = lastError?.message ?? "re-add exhausted the retry ladder";
      log("rebalance_error", `Re-add failed after withdraw (${failMsg}) — closing empty account, funds stay in wallet`);
      await reclaimEmptyPositionAccount(pool, wallet, position_address, { label: "rebalance_error" });
      recordClose(position_address, `rebalance failed after withdraw (${failMsg}) — funds returned to wallet`);
      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: String(poolAddress),
        pool_name: tracked?.pool_name || poolMeta.name || String(poolAddress).slice(0, 8),
        position: position_address,
        summary: "Rebalance failed after withdraw — position closed, funds in wallet",
        reason: reason || plan.reason || "rebalance failed",
        metrics: { exit_signal_type: "rebalance_failed", rebalance_type: plan.rebalance_type },
      });
      return { success: false, error: `Rebalance re-add failed: ${failMsg}`, funds_withdrawn: true, position_closed: true };
    }

    const updated = recordRebalance(position_address, {
      plan: {
        ...plan,
        strategy: added.strategy,
        bins_below: added.binsBelow,
        bins_above: added.binsAbove,
        min_bin: added.minBinId,
        max_bin: added.maxBinId,
      },
      tx_hashes: added.txHashes,
      new_position: added.newPositionAddress !== position_address ? added.newPositionAddress : null,
    });

    appendDecision({
      type: "rebalance",
      actor: "MANAGER",
      pool: String(poolAddress),
      pool_name: tracked?.pool_name || poolMeta.name || String(poolAddress).slice(0, 8),
      position: added.newPositionAddress,
      summary: `Rebalanced (${plan.rebalance_type}, ${added.path}): ${added.strategy} ${added.binsBelow}/${added.binsAbove} @ bin ${added.activeBinId}`,
      reason: reason || plan.reason || "rebalance",
      metrics: {
        rebalance_type: plan.rebalance_type,
        rebalance_path: added.path,
        rebalance_count: updated?.rebalance_count ?? null,
        market_view: plan.market_view ?? null,
        oor_direction: plan.oor_direction ?? null,
        oor_risk: plan.oor_risk ?? null,
        bins_used: added.binsBelow + added.binsAbove,
        min_bin: added.minBinId,
        max_bin: added.maxBinId,
        active_bin: added.activeBinId,
        deploy_retries: added.retries,
        old_position: added.newPositionAddress !== position_address ? position_address : null,
      },
    });

    log("rebalance", `SUCCESS (${added.path}) — ${plan.rebalance_type}: ${added.strategy} ${added.binsBelow}/${added.binsAbove} @ ${added.activeBinId}, ${added.txHashes.length} tx(s)`);
    return {
      success: true,
      position: added.newPositionAddress,
      old_position: position_address,
      pool: String(poolAddress),
      pool_name: tracked?.pool_name || poolMeta.name || null,
      rebalance_type: plan.rebalance_type,
      rebalance_path: added.path,
      strategy: added.strategy,
      bin_range: { min: added.minBinId, max: added.maxBinId, active: added.activeBinId },
      txs: added.txHashes,
      retries: added.retries,
    };
  } catch (error) {
    log("rebalance_error", error.message);
    return { success: false, error: error.message };
  }
}

// ─── Close Position ────────────────────────────────────────────
export async function closePosition({ position_address, reason }) {
  position_address = normalizeMint(position_address);
  if (process.env.DRY_RUN === "true") {
    return { dry_run: true, would_close: position_address, message: "DRY RUN — no transaction sent" };
  }

  const tracked = getTrackedPosition(position_address);

  try {
    log("close", `Closing position: ${position_address}`);
    const wallet = getWallet();
    const poolAddress = await lookupPoolForPosition(position_address, wallet.publicKey.toString());
    const poolMeta = await getPoolMetadata(poolAddress);
    if (shouldUseLpAgentRelay()) {
      let relaySubmitted = false;
      try {
      const pool = await getPool(poolAddress);
      const relayAllowedDebitMints = [
        pool.lbPair.tokenXMint.toString(),
        pool.lbPair.tokenYMint.toString(),
        config.tokens.SOL,
      ];
      const livePositions = await getMyPositions({ force: true, silent: true });
      const livePosition = livePositions?.positions?.find((position) => position.position === position_address);
      const closeFromBinId = livePosition?.lower_bin ?? tracked?.bin_range?.min ?? -887272;
      const closeToBinId = livePosition?.upper_bin ?? tracked?.bin_range?.max ?? 887272;
      const closeOutput = "allToken1";

      const order = await agentMeridianJson("/execution/zap-out/order", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          agentId: getAgentIdForRequests(),
          idempotencyKey: `close:${position_address}:10000`,
          positionId: position_address,
          owner: wallet.publicKey.toString(),
          bps: 10000,
          slippageBps: 5000,
          output: closeOutput,
          provider: "OKX",
          type: "meteora",
          fromBinId: closeFromBinId,
          toBinId: closeToBinId,
        }),
      });

      const closeUnsigned = order?.order?.transactions?.close || [];
      const swapUnsigned = order?.order?.transactions?.swap || [];
      if (closeUnsigned.length + swapUnsigned.length === 0) {
        throw new Error("LPAgent close order returned no transactions. Check the position, selected output, and relay order response.");
      }

      const closeSigned = await signAndSimulateRelayTransactions(closeUnsigned, wallet, {
        label: "zap-out close",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString(), position_address],
      });
      const swapSigned = await signAndSimulateRelayTransactions(swapUnsigned, wallet, {
        label: "zap-out swap",
        allowedDebitMints: relayAllowedDebitMints,
        maxSolLoss: 0.05,
        requiredStaticAccounts: [wallet.publicKey.toString()],
      });

      relaySubmitted = true;
      const submit = await agentMeridianJson("/execution/zap-out/submit", {
        method: "POST",
        headers: getAgentMeridianHeaders({ json: true }),
        body: JSON.stringify({
          requestId: order.requestId,
          lastValidBlockHeight: order?.order?.lastValidBlockHeight,
          transactions: {
            close: closeSigned,
            swap: swapSigned,
          },
        }),
      });

      const claimTxHashes = [];
      const closeTxHashes = normalizeExecutionSignatures(submit);
      const txHashes = [...claimTxHashes, ...closeTxHashes];

      await new Promise((resolve) => setTimeout(resolve, 5000));
      _positionsCacheAt = 0;

      let closedConfirmed = false;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const refreshed = await getMyPositions({ force: true, silent: true });
          const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
          if (!stillOpen) {
            closedConfirmed = true;
            break;
          }
          log("close_warn", `Relay close still appears open after submit (attempt ${attempt + 1}/4)`);
        } catch (e) {
          log("close_warn", `Relay close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      if (!closedConfirmed) {
        return {
          success: false,
          error: "Close submit succeeded but position still appears open after verification window",
          position: position_address,
          pool: poolAddress,
          close_txs: closeTxHashes,
          txs: txHashes,
        };
      }

      recordClose(position_address, reason || "agent decision");

      if (tracked) {
        const deployedAt = new Date(tracked.deployed_at).getTime();
        const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);
        let minutesOOR = 0;
        if (tracked.out_of_range_since) {
          minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
        }

        let pnlUsd = 0;
        let pnlTrueUsd = 0;
        let pnlPct = 0;
        let finalValueUsd = 0;
        let initialUsd = 0;
        let feesUsd = tracked.total_fees_claimed_usd || 0;
        try {
          const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
          for (let attempt = 0; attempt < 6; attempt++) {
            const res = await fetch(closedUrl);
            if (res.ok) {
              const data = await res.json();
              const posEntry = (data.positions || []).find((entry) => entry.positionAddress === position_address);
              if (posEntry) {
                pnlTrueUsd = safeNum(posEntry.pnlUsd);
                pnlUsd = config.management.solMode ? getClosedPnlValue(posEntry, true) : pnlTrueUsd;
                pnlPct = getClosedPnlPct(posEntry, config.management.solMode);
                finalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
                initialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
                feesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;
                break;
              }
            }
            if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        } catch (e) {
          log("close_warn", `Relay closed PnL fetch failed: ${e.message}`);
        }

        const closeBaseMint = livePosition?.base_mint || pool.lbPair.tokenXMint.toString();
        const signalSnapshot = resolvePerformanceSignalSnapshot({
          poolAddress,
          baseMint: closeBaseMint,
          tracked,
        });

        let exitMarket = {};
        try {
          const { default: fetch } = await import("node-fetch").catch(() => ({ default: globalThis.fetch }));
          const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
          const ep = exitDetail?.data?.[0];
          if (ep) {
            exitMarket = {
              exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
              exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
              exit_volume: parseFloat(ep?.volume) || null,
            };
          }
        } catch { /* non-blocking */ }

        await recordPerformance({
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          base_mint: closeBaseMint,
          strategy: tracked.strategy,
          bin_range: tracked.bin_range,
          bin_step: tracked.bin_step || null,
          volatility: tracked.volatility ?? null,
          fee_tvl_ratio: tracked.fee_tvl_ratio || null,
          organic_score: tracked.organic_score || null,
          amount_sol: tracked.amount_sol,
          fees_earned_usd: feesUsd,
          final_value_usd: finalValueUsd,
          initial_value_usd: initialUsd,
          minutes_in_range: minutesHeld - minutesOOR,
          minutes_held: minutesHeld,
          close_reason: reason || "agent decision",
          signal_snapshot: signalSnapshot,
          entry_mcap: tracked.entry_mcap ?? null,
          entry_tvl: tracked.entry_tvl ?? null,
          entry_volume: tracked.entry_volume ?? null,
          entry_holders: tracked.entry_holders ?? null,
          ...exitMarket,
        });

        appendDecision({
          type: "close",
          actor: "MANAGER",
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
          position: position_address,
          summary: `Relay closed at ${pnlPct.toFixed(2)}%`,
          reason: reason || "agent decision",
          risks: [
            minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
            tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
          ].filter(Boolean),
          metrics: {
            pnl_usd: pnlUsd,
            pnl_pct: pnlPct,
            fees_usd: feesUsd,
            minutes_held: minutesHeld,
          },
        });

        // Auto-swap base token if configured
        let autoSwapResult = null;
        if (config.management.autoSwapAfterClose && closeBaseMint && closeBaseMint !== config.tokens.SOL) {
          log("close_auto_swap", `Auto-swapping ${closeBaseMint.slice(0, 8)}... → SOL`);
          try {
            const { swapToken } = await import("./wallet.js");
            // Get balance of base token (estimate from position size)
            const estimatedBaseAmount = 100; // Placeholder — actual amount determined by position
            autoSwapResult = await swapToken({
              input_mint: closeBaseMint,
              output_mint: config.tokens.SOL,
              amount: estimatedBaseAmount,
            });
            if (autoSwapResult?.success) {
              log("close_auto_swap", `✓ Auto-swapped ${closeBaseMint.slice(0, 8)}... TX: ${autoSwapResult.tx.slice(0, 20)}...`);
            }
          } catch (swapErr) {
            log("close_auto_swap_warn", `Auto-swap failed: ${swapErr.message}`);
          }
        }

        return {
          success: true,
          relay: true,
          request_id: order.requestId,
          position: position_address,
          pool: poolAddress,
          pool_name: tracked.pool_name || poolMeta.name || null,
          claim_txs: claimTxHashes,
          close_txs: closeTxHashes,
          txs: txHashes,
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          base_mint: closeBaseMint,
          auto_swapped: autoSwapResult?.success || false,
          auto_swap_tx: autoSwapResult?.tx || null,
        };
      }

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: "Relay closed position",
        reason: reason || "agent decision",
        metrics: {},
      });

      return {
        success: true,
        relay: true,
        request_id: order.requestId,
        position: position_address,
        pool: poolAddress,
        pool_name: poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        base_mint: livePosition?.base_mint || null,
      };
      } catch (relayError) {
        if (relaySubmitted) throw relayError;
        log("close_warn", `Relay zap-out failed before submit; falling back to local close + Jupiter autoswap: ${relayError.message}`);
      }
    }

    // Clear cached pool so SDK loads fresh position fee state
    poolCache.delete(poolAddress.toString());
    const pool = await getPool(poolAddress);

    const positionPubKey = new PublicKey(position_address);
    const claimTxHashes = [];
    const closeTxHashes = [];

    // ─── Step 1: Claim Fees (to clear account state) ───────────
    const recentlyClaimed = tracked?.last_claim_at && (Date.now() - new Date(tracked.last_claim_at).getTime()) < 60_000;
    try {
      if (recentlyClaimed) {
        log("close", `Step 1: Skipping claim — fees already claimed ${Math.round((Date.now() - new Date(tracked.last_claim_at).getTime()) / 1000)}s ago`);
      } else {
        log("close", `Step 1: Claiming fees for ${position_address}`);
        const positionData = await pool.getPosition(positionPubKey);
        const claimTxs = await pool.claimSwapFee({
          owner: wallet.publicKey,
          position: positionData,
        });
        if (claimTxs && claimTxs.length > 0) {
          for (const tx of claimTxs) {
            const claimHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
            claimTxHashes.push(claimHash);
          }
          log("close", `Step 1 OK (claim only): ${claimTxHashes.join(", ")}`);
        }
      }
    } catch (e) {
      log("close_warn", `Step 1 (Claim) failed or nothing to claim: ${e.message}`);
    }

    // ─── Step 2: Remove Liquidity & Close ──────────────────────
    let hasLiquidity = false;
    let closeFromBinId = -887272;
    let closeToBinId = 887272;
    try {
      const positionDataForClose = await pool.getPosition(positionPubKey);
      const processed = positionDataForClose?.positionData;
      if (processed) {
        closeFromBinId = processed.lowerBinId ?? closeFromBinId;
        closeToBinId = processed.upperBinId ?? closeToBinId;
        const bins = Array.isArray(processed.positionBinData) ? processed.positionBinData : [];
        hasLiquidity = bins.some((bin) => new BN(bin.positionLiquidity || "0").gt(new BN(0)));
      }
    } catch (e) {
      log("close_warn", `Could not check liquidity state: ${e.message}`);
    }

    if (hasLiquidity) {
      log("close", `Step 2: Removing liquidity and closing account`);
      const closeTx = await pool.removeLiquidity({
        user: wallet.publicKey,
        position: positionPubKey,
        fromBinId: closeFromBinId,
        toBinId: closeToBinId,
        bps: new BN(10000),
        shouldClaimAndClose: true,
      });

      for (const tx of Array.isArray(closeTx) ? closeTx : [closeTx]) {
        const txHash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
        closeTxHashes.push(txHash);
      }
    } else {
      log("close", `Step 2: No position liquidity detected, closing account`);
      const closeTx = await pool.closePosition({
        owner: wallet.publicKey,
        position: { publicKey: positionPubKey },
      });
      const txHash = await sendAndConfirmTransaction(getConnection(), closeTx, [wallet]);
      closeTxHashes.push(txHash);
    }
    const txHashes = [...claimTxHashes, ...closeTxHashes];
    log("close", `Step 2 OK (close only): ${closeTxHashes.join(", ") || "none"}`);
    log("close", `SUCCESS txs: ${txHashes.join(", ")}`);
    // Wait for RPC to reflect withdrawn balances before returning — prevents
    // agent from seeing zero balance when attempting post-close swap
    await new Promise(r => setTimeout(r, 5000));
    _positionsCacheAt = 0;

    let closedConfirmed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const refreshed = await getMyPositions({ force: true, silent: true });
        const stillOpen = refreshed?.positions?.some((p) => p.position === position_address);
        if (!stillOpen) {
          closedConfirmed = true;
          break;
        }
        log("close_warn", `Position ${position_address} still appears open after close txs (attempt ${attempt + 1}/4)`);
      } catch (e) {
        log("close_warn", `Close verification failed (attempt ${attempt + 1}/4): ${e.message}`);
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
    }

    if (!closedConfirmed) {
      return {
        success: false,
        error: "Close transactions sent but position still appears open after verification window",
        position: position_address,
        pool: poolAddress,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
      };
    }

    recordClose(position_address, reason || "agent decision");

    // Record performance for learning
    if (tracked) {
      const deployedAt = new Date(tracked.deployed_at).getTime();
      const minutesHeld = Math.floor((Date.now() - deployedAt) / 60000);

      let minutesOOR = 0;
      if (tracked.out_of_range_since) {
        minutesOOR = Math.floor((Date.now() - new Date(tracked.out_of_range_since).getTime()) / 60000);
      }

      const shouldRejectClosedPnl = (pct, closeReasonText) => {
        if (!Number.isFinite(pct)) return false;
        const reasonText = String(closeReasonText || "").toLowerCase();
        const stopLossTriggered = reasonText.includes("stop loss");
        // Meteora sometimes briefly reports absurd closed pnl while the record is settling.
        // Trust legitimate stop-loss disasters, but reject obviously unsettled outliers otherwise.
        return !stopLossTriggered && pct <= -90;
      };

      // Fetch closed PnL from API — authoritative source after withdrawal settles
      let pnlUsd = 0;
      let pnlTrueUsd = 0;
      let pnlPct = 0;
      let finalValueUsd = 0;
      let initialUsd = 0;
      let feesUsd = tracked.total_fees_claimed_usd || 0;
      try {
        const closedUrl = `https://dlmm.datapi.meteora.ag/positions/${poolAddress}/pnl?user=${wallet.publicKey.toString()}&status=closed&pageSize=50&page=1`;
        for (let attempt = 0; attempt < 6; attempt++) {
          const res = await fetch(closedUrl);
          if (res.ok) {
            const data = await res.json();
            const posEntry = (data.positions || []).find(p => p.positionAddress === position_address);
            if (posEntry) {
              const nextPnlUsd = safeNum(posEntry.pnlUsd);
              const nextPnlValue = config.management.solMode ? getClosedPnlValue(posEntry, true) : nextPnlUsd;
              const nextPnlPct = getClosedPnlPct(posEntry, config.management.solMode);
              const nextFinalValueUsd = parseFloat(posEntry.allTimeWithdrawals?.total?.usd || 0);
              const nextInitialUsd = parseFloat(posEntry.allTimeDeposits?.total?.usd || 0);
              const nextFeesUsd = parseFloat(posEntry.allTimeFees?.total?.usd || 0) || feesUsd;

              if (shouldRejectClosedPnl(nextPnlPct, reason || tracked?.close_reason)) {
                log("close_warn", `Rejected unsettled closed PnL for ${position_address.slice(0, 8)} on attempt ${attempt + 1}/6: ${nextPnlPct.toFixed(2)}%`);
              } else {
                pnlTrueUsd    = nextPnlUsd;
                pnlUsd        = nextPnlValue;
                pnlPct        = nextPnlPct;
                finalValueUsd = nextFinalValueUsd;
                initialUsd    = nextInitialUsd;
                feesUsd       = nextFeesUsd;
                log("close", `Closed PnL from API: pnl=${pnlUsd.toFixed(2)} ${config.management.solMode ? "SOL" : "USD"} (${pnlPct.toFixed(2)}%), withdrawn=${finalValueUsd.toFixed(2)} USD, deposited=${initialUsd.toFixed(2)} USD`);
                break;
              }
            } else {
              log("close_warn", `Position not found in status=closed response (attempt ${attempt + 1}/6) — may still be settling`);
            }
          }
          if (attempt < 5) await new Promise((r) => setTimeout(r, 5000));
        }
      } catch (e) {
        log("close_warn", `Closed PnL fetch failed: ${e.message}`);
      }
      // Fallback to pre-close cache snapshot if closed API had no data
      if (finalValueUsd === 0) {
        const cachedPos = _positionsCache?.positions?.find(p => p.position === position_address);
        if (cachedPos) {
          pnlTrueUsd    = cachedPos.pnl_true_usd ?? (config.management.solMode ? 0 : cachedPos.pnl_usd) ?? 0;
          pnlUsd        = config.management.solMode ? (cachedPos.pnl_usd ?? 0) : pnlTrueUsd;
          pnlPct        = cachedPos.pnl_pct   ?? 0;
          feesUsd       = (cachedPos.collected_fees_true_usd || 0) + (cachedPos.unclaimed_fees_true_usd || 0);
          initialUsd    = tracked.initial_value_usd || 0;
          if (initialUsd > 0) {
            // Keep fallback internally consistent using USD-only cached metrics.
            finalValueUsd = Math.max(0, initialUsd + pnlTrueUsd - feesUsd);
            if (!config.management.solMode) pnlPct = (pnlTrueUsd / initialUsd) * 100;
          } else {
            finalValueUsd = cachedPos.total_value_true_usd ?? cachedPos.total_value_usd ?? 0;
            initialUsd = Math.max(0, finalValueUsd + feesUsd - pnlTrueUsd);
          }
          log("close_warn", `Using cached pnl fallback because closed API has not settled yet`);
        }
      }

      const closeBaseMint = pool.lbPair.tokenXMint.toString();
      const signalSnapshot = resolvePerformanceSignalSnapshot({
        poolAddress,
        baseMint: closeBaseMint,
        tracked,
      });

      let exitMarket = {};
      try {
        const exitDetail = await fetch(`https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(config.screening?.timeframe || "5m")}`).then(r => r.json()).catch(() => null);
        const ep = exitDetail?.data?.[0];
        if (ep) {
          exitMarket = {
            exit_mcap: parseFloat(ep?.token_x?.market_cap) || null,
            exit_tvl: parseFloat(ep?.tvl ?? ep?.active_tvl) || null,
            exit_volume: parseFloat(ep?.volume) || null,
          };
        }
      } catch { /* non-blocking */ }

      await recordPerformance({
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        base_mint: closeBaseMint,
        strategy: tracked.strategy,
        bin_range: tracked.bin_range,
        bin_step: tracked.bin_step || null,
        volatility: tracked.volatility ?? null,
        fee_tvl_ratio: tracked.fee_tvl_ratio || null,
        organic_score: tracked.organic_score || null,
        amount_sol: tracked.amount_sol,
        fees_earned_usd: feesUsd,
        final_value_usd: finalValueUsd,
        initial_value_usd: initialUsd,
        minutes_in_range: minutesHeld - minutesOOR,
        minutes_held: minutesHeld,
        close_reason: reason || "agent decision",
        signal_snapshot: signalSnapshot,
        entry_mcap: tracked.entry_mcap ?? null,
        entry_tvl: tracked.entry_tvl ?? null,
        entry_volume: tracked.entry_volume ?? null,
        entry_holders: tracked.entry_holders ?? null,
        ...exitMarket,
      });

      appendDecision({
        type: "close",
        actor: "MANAGER",
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || poolAddress.slice(0, 8),
        position: position_address,
        summary: `Closed at ${pnlPct.toFixed(2)}%`,
        reason: reason || "agent decision",
        risks: [
          minutesOOR > 0 ? `out of range ${minutesOOR}m` : null,
          tracked.volatility != null ? `volatility ${tracked.volatility}` : null,
        ].filter(Boolean),
        metrics: {
          pnl_usd: pnlUsd,
          pnl_pct: pnlPct,
          fees_usd: feesUsd,
          minutes_held: minutesHeld,
          exit_signal_type: classifyExitSignal(reason),
          minutes_oor: minutesOOR,
        },
      });

      return {
        success: true,
        position: position_address,
        pool: poolAddress,
        pool_name: tracked.pool_name || poolMeta.name || null,
        claim_txs: claimTxHashes,
        close_txs: closeTxHashes,
        txs: txHashes,
        pnl_usd: pnlUsd,
        pnl_pct: pnlPct,
        base_mint: closeBaseMint,
      };
    }

    appendDecision({
      type: "close",
      actor: "MANAGER",
      pool: poolAddress,
      pool_name: poolMeta.name || poolAddress.slice(0, 8),
      position: position_address,
      summary: "Closed position",
      reason: reason || "agent decision",
      metrics: {},
    });

    return {
      success: true,
      position: position_address,
      pool: poolAddress,
      pool_name: poolMeta.name || null,
      claim_txs: claimTxHashes,
      close_txs: closeTxHashes,
      txs: txHashes,
      base_mint: pool.lbPair.tokenXMint.toString(),
    };
  } catch (error) {
    log("close_error", error.message);
    return { success: false, error: error.message };
  }
}

/** Bucket a free-text close reason into a stable exit_signal_type for the decision log. */
function classifyExitSignal(reason) {
  const text = String(reason || "").toLowerCase();
  if (!text || text === "agent decision") return "agent_decision";
  if (text.includes("external") || text.includes("manual")) return "manual_or_external";
  if (text.includes("stop loss")) return "stop_loss";
  if (text.includes("trailing")) return "trailing_tp";
  if (text.includes("chart exit")) return "chart_exit";
  if (text.includes("tvl dilution")) return "tvl_dilution";
  if (text.includes("low yield")) return "low_yield";
  if (text.includes("out of range") || text.includes("oor") || text.includes("pumped far above")) return "out_of_range";
  if (text.includes("take profit") || text.includes("tp")) return "take_profit";
  if (text.includes("rug") || text.includes("emergency")) return "emergency";
  return "other";
}

// ─── Helpers ──────────────────────────────────────────────────
async function lookupPoolForPosition(position_address, walletAddress) {
  // Check state registry first (fast path)
  const tracked = getTrackedPosition(position_address);
  if (tracked?.pool) return tracked.pool;

  // Check in-memory positions cache
  const cached = _positionsCache?.positions?.find((p) => p.position === position_address);
  if (cached?.pool) return cached.pool;

  // SDK scan (last resort)
  const { DLMM } = await getDLMM();
  const allPositions = await DLMM.getAllLbPairPositionsByUser(
    getConnection(),
    new PublicKey(walletAddress)
  );

  for (const [lbPairKey, positionData] of Object.entries(allPositions)) {
    for (const pos of positionData.lbPairPositionsData || []) {
      if (pos.publicKey.toString() === position_address) return lbPairKey;
    }
  }

  throw new Error(`Position ${position_address} not found in open positions`);
}
