import { Connection } from "@solana/web3.js";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  CpAmmIdl,
  getPriceFromSqrtPrice,
  getDynamicFeeNumerator,
  isDynamicFeeEnabled,
  getBaseFeeHandlerFromPodAlignedData,
  getBaseFeeModeFromPodAlignedData,
  FEE_DENOMINATOR,
  type PoolState,
} from "@meteora-ag/cp-amm-sdk";

// Decode through an Anchor Program so field names come out camelCase (the SDK's bare
// coder returns snake_case). Pure byte parsing; the connection is never used for network calls.
const provider = new AnchorProvider(
  new Connection("http://127.0.0.1:8899"),
  {} as any,
  AnchorProvider.defaultOptions(),
);
const program = new Program(CpAmmIdl as any, provider);

export type DammV2PoolState = {
  venue: "meteora_damm_v2";
  address: string;
  tokenAMint: string;
  tokenBMint: string;
  tokenAVault: string;
  tokenBVault: string;
  sqrtPrice: string;
  liquidity: string;
  poolStatus: number;
  collectFeeMode: number;
  baseFeeMode: number;
  /** Base fee range in basis points. Equal min and max means a fixed fee (no scheduler running). */
  baseFeeBpsMin: number;
  baseFeeBpsMax: number;
  /** Extra volatility fee in basis points right now (0 when dynamic fee is off or the market is calm). */
  dynamicFeeBps: number;
  /** Worst-case fee a swap pays right now: max base + dynamic, in basis points. */
  totalFeeBps: number;
  /** Price: token B per token A, adjusted for decimals (e.g. SOL per PERPSPAD). */
  price: number;
};

/** The SDK's full pool state (camelCase). The quoter needs all of it; the summary below is for logging. */
export function decodeDammV2Raw(data: Buffer): PoolState {
  return program.coder.accounts.decode("pool", data) as PoolState;
}

export function decodeDammV2Pool(
  address: string,
  data: Buffer,
  decimalsA: number,
  decimalsB: number,
): DammV2PoolState {
  return summarizeDammV2(address, decodeDammV2Raw(data), decimalsA, decimalsB);
}

export function summarizeDammV2(
  address: string,
  pool: PoolState,
  decimalsA: number,
  decimalsB: number,
): DammV2PoolState {
  const price = getPriceFromSqrtPrice(pool.sqrtPrice, decimalsA, decimalsB).toNumber();

  const baseFeeBytes = pool.poolFees.baseFee.baseFeeInfo.data;
  const handler = getBaseFeeHandlerFromPodAlignedData(baseFeeBytes);
  const baseFeeMode = getBaseFeeModeFromPodAlignedData(baseFeeBytes);
  const baseMin = handler.getMinFeeNumerator();
  const baseMax = handler.getMaxFeeNumerator();

  const dyn = pool.poolFees.dynamicFee;
  const dynamicFeeNumerator = isDynamicFeeEnabled(dyn)
    ? getDynamicFeeNumerator(new BN(dyn.volatilityAccumulator), new BN(dyn.binStep), new BN(dyn.variableFeeControl))
    : new BN(0);

  const toBps = (n: BN) => (n.toNumber() / FEE_DENOMINATOR) * 10_000;
  return {
    venue: "meteora_damm_v2",
    address,
    tokenAMint: pool.tokenAMint.toBase58(),
    tokenBMint: pool.tokenBMint.toBase58(),
    tokenAVault: pool.tokenAVault.toBase58(),
    tokenBVault: pool.tokenBVault.toBase58(),
    sqrtPrice: pool.sqrtPrice.toString(),
    liquidity: pool.liquidity.toString(),
    poolStatus: Number(pool.poolStatus),
    collectFeeMode: Number(pool.collectFeeMode),
    baseFeeMode: Number(baseFeeMode),
    baseFeeBpsMin: toBps(baseMin),
    baseFeeBpsMax: toBps(baseMax),
    dynamicFeeBps: toBps(dynamicFeeNumerator),
    totalFeeBps: toBps(baseMax.add(dynamicFeeNumerator)),
    price,
  };
}
