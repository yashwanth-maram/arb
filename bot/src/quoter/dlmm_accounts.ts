import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  LBCLMM_PROGRAM_IDS,
  deriveBinArray,
  deriveBinArrayBitmapExtension,
  findNextBinArrayIndexWithLiquidity,
  getBinArrayLowerUpperBinId,
  type BinArrayBitmapExtension,
  type LbPair,
} from "@meteora-ag/dlmm";

export const DLMM_PROGRAM_ID = new PublicKey(LBCLMM_PROGRAM_IDS["mainnet-beta"]);

/**
 * A DLMM pool keeps its liquidity in "bin arrays": separate accounts of 70 price bins each. A swap starts in
 * the array holding the active bin and walks into neighbours as bins run dry. This returns the indexes of the
 * arrays a swap in one direction would visit, nearest first, skipping empty stretches by following the pool's
 * own liquidity bitmap (the same walk as the SDK's getBinArrayForSwap, without the network calls).
 *   swapForY = true  : token X in, token Y out, price moves down, arrays at and below the active bin
 *   swapForY = false : token Y in, token X out, price moves up, arrays at and above the active bin
 */
export function binArrayIndexesForSwap(
  lbPair: LbPair,
  bitmapExtension: BinArrayBitmapExtension | null,
  swapForY: boolean,
  count: number,
): number[] {
  const out: number[] = [];
  let binId = Number(lbPair.activeId);
  while (out.length < count) {
    const index = findNextBinArrayIndexWithLiquidity(swapForY, new BN(binId), lbPair, bitmapExtension);
    if (index === null) break;
    out.push(index.toNumber());
    const [lower, upper] = getBinArrayLowerUpperBinId(index);
    binId = swapForY ? lower.toNumber() - 1 : upper.toNumber() + 1;
  }
  return out;
}

/** Every bin array either direction would touch, without duplicates (the active array serves both directions). */
export function binArrayIndexesBothWays(lbPair: LbPair, bitmapExtension: BinArrayBitmapExtension | null, countPerSide: number): number[] {
  const all = [...binArrayIndexesForSwap(lbPair, bitmapExtension, true, countPerSide), ...binArrayIndexesForSwap(lbPair, bitmapExtension, false, countPerSide)];
  return [...new Set(all)].sort((a, b) => a - b);
}

export function binArrayAddress(pool: PublicKey, index: number): PublicKey {
  return deriveBinArray(pool, new BN(index), DLMM_PROGRAM_ID)[0];
}

export function bitmapExtensionAddress(pool: PublicKey): PublicKey {
  return deriveBinArrayBitmapExtension(pool, DLMM_PROGRAM_ID)[0];
}
