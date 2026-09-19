import { Connection } from "@solana/web3.js";
import Decimal from "decimal.js";
import {
  createProgram,
  decodeAccount,
  getBaseFee,
  getTotalFee,
  getPriceOfBinByBinId,
  type BinArray,
  type BinArrayBitmapExtension,
  type LbPair,
} from "@meteora-ag/dlmm";

// The SDK decodes through an Anchor Program object. Decoding is pure byte parsing;
// the connection below is never used for network calls by this module.
const program = createProgram(new Connection("http://127.0.0.1:8899"));

export type DlmmPoolState = {
  venue: "meteora_dlmm";
  address: string;
  tokenXMint: string;
  tokenYMint: string;
  reserveX: string;
  reserveY: string;
  activeId: number;
  binStep: number;
  status: number;
  /** Base fee in basis points (100 bps = 1%). */
  baseFeeBps: number;
  /** Base + volatility fee at this snapshot, in basis points. This is what a swap pays right now. */
  totalFeeBps: number;
  /** Price of the active bin: token Y per token X, adjusted for decimals (e.g. SOL per PERPSPAD). */
  price: number;
  lastUpdatedAt: number;
};

const FEE_PRECISION = 1_000_000_000; // DLMM fee rates are scaled by 1e9

/** The SDK's full pool state. The quoter needs all of it (liquidity bitmap, fee parameters); the summary is for logging. */
export function decodeDlmmRaw(data: Buffer): LbPair {
  return decodeAccount<LbPair>(program, "lbPair", data);
}

/** One bin array: 70 consecutive price bins with the liquidity sitting in each. */
export function decodeBinArray(data: Buffer): BinArray {
  return decodeAccount<BinArray>(program, "binArray", data);
}

/** Optional per-pool account that extends the liquidity bitmap beyond the 1,024 bin arrays tracked inside the pool. */
export function decodeBitmapExtension(data: Buffer): BinArrayBitmapExtension {
  return decodeAccount<BinArrayBitmapExtension>(program, "binArrayBitmapExtension", data);
}

export function decodeDlmmPool(
  address: string,
  data: Buffer,
  decimalsX: number,
  decimalsY: number,
): DlmmPoolState {
  return summarizeDlmm(address, decodeDlmmRaw(data), decimalsX, decimalsY);
}

export function summarizeDlmm(address: string, lb: LbPair, decimalsX: number, decimalsY: number): DlmmPoolState {
  const activeId = Number(lb.activeId);
  const binStep = Number(lb.binStep);
  const priceRaw = getPriceOfBinByBinId(activeId, binStep); // y per x in raw units: (1 + binStep/10000)^activeId
  const price = priceRaw.mul(new Decimal(10).pow(decimalsX - decimalsY)).toNumber();
  const baseFee = getBaseFee(binStep, lb.parameters).toNumber();
  const totalFee = getTotalFee(binStep, lb.parameters, lb.vParameters).toNumber();
  return {
    venue: "meteora_dlmm",
    address,
    tokenXMint: lb.tokenXMint.toBase58(),
    tokenYMint: lb.tokenYMint.toBase58(),
    reserveX: lb.reserveX.toBase58(),
    reserveY: lb.reserveY.toBase58(),
    activeId,
    binStep,
    status: Number(lb.status),
    baseFeeBps: (baseFee / FEE_PRECISION) * 10_000,
    totalFeeBps: (totalFee / FEE_PRECISION) * 10_000,
    price,
    lastUpdatedAt: Number(lb.lastUpdatedAt),
  };
}
