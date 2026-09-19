import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM, { createProgram, type BinArray, type BinArrayBitmapExtension, type LbPair } from "@meteora-ag/dlmm";
import { WSOL } from "../config/watchlist";
import { binArrayAddress, bitmapExtensionAddress } from "./dlmm_accounts";
import type { Clock, LegQuote, Side } from "./types";

// The SDK's swap quote lives on its DLMM class. We build that object from accounts we already hold, so a quote
// costs no network call. The connection is never used; mint details only matter for Token-2022 transfer fees,
// which our watchlist rule (classic SPL Token mints only) keeps out.
const program = createProgram(new Connection("http://127.0.0.1:8899"));
const classicMint = { tlvData: Buffer.alloc(0) };

// Deriving a bin array's address costs a few hashes; the answer never changes, so remember it.
const addressCache = new Map<string, PublicKey>();
function cachedBinArrayAddress(pool: PublicKey, index: number): PublicKey {
  const key = `${pool.toBase58()}:${index}`;
  let address = addressCache.get(key);
  if (!address) { address = binArrayAddress(pool, index); addressCache.set(key, address); }
  return address;
}

/** Everything a DLMM quote needs, already decoded. binArrays: bin array index -> decoded account, for the arrays we hold. */
export type DlmmQuoteState = {
  address: string;
  lbPair: LbPair;
  bitmapExtension: BinArrayBitmapExtension | null;
  binArrays: Map<number, BinArray>;
};

/**
 * Depth-aware quote for one swap through a DLMM pool: the SDK's own swapQuote walking the real bins, fee and
 * limit orders included. Throws if the bin arrays we hold cannot fill the whole amount. The variable fee depends
 * on the time since the pool's last swap, so the quote is computed "as of" clock.unixTime.
 */
export function quoteDlmm(state: DlmmQuoteState, side: Side, amountIn: BN, clock: Clock): LegQuote {
  const solIsX = state.lbPair.tokenXMint.toBase58() === WSOL;
  const solIsY = state.lbPair.tokenYMint.toBase58() === WSOL;
  if (solIsX === solIsY) throw new Error("pool must have SOL on exactly one side");
  if (amountIn.lten(0)) throw new Error("amountIn must be greater than 0");

  // swapForY means "token X in, token Y out". A buy puts SOL in; a sell puts the token in.
  const swapForY = side === "sell" ? solIsY : solIsX;
  const pool = new PublicKey(state.address);
  const token = (mint: PublicKey, reserve: PublicKey) =>
    ({ publicKey: mint, reserve, mint: classicMint, amount: BigInt(0), owner: PublicKey.default, transferHookAccountMetas: [] }) as any;
  const sdkClock = { slot: new BN(clock.slot), epoch: new BN(0), unixTimestamp: new BN(clock.unixTime) } as any;
  const dlmm = new DLMM(
    pool, program, state.lbPair,
    state.bitmapExtension ? { publicKey: bitmapExtensionAddress(pool), account: state.bitmapExtension } : null,
    token(state.lbPair.tokenXMint, state.lbPair.reserveX), token(state.lbPair.tokenYMint, state.lbPair.reserveY),
    [null, null], sdkClock,
  );
  const binArrays = [...state.binArrays].map(([index, account]) => ({ publicKey: cachedBinArrayAddress(pool, index), account }));

  // The SDK reads the wall clock inside swapQuote. Pin it to the caller's clock for the length of this one
  // synchronous call, so the same inputs always give the same quote (tests, replays) and live use is unchanged.
  const realNow = Date.now;
  Date.now = () => clock.unixTime * 1000;
  try {
    const q = dlmm.swapQuote(amountIn, swapForY, new BN(0), binArrays, false, 0);
    const fee = q.fee.add(q.protocolFee); // the SDK reports the liquidity providers' part and the protocol's part separately
    const feeBase = q.feeOnInput ? q.consumedInAmount : q.outAmount.add(fee);
    const feeBps = feeBase.isZero() ? 0 : (Number(fee.toString()) / Number(feeBase.toString())) * 10_000;
    return { side, amountIn: q.consumedInAmount, amountOut: q.outAmount, fee, feeBps };
  } finally {
    Date.now = realNow;
  }
}
