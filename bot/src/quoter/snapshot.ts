import { readFileSync } from "node:fs";
import type { PoolState } from "@meteora-ag/cp-amm-sdk";
import { decodeDlmmRaw, decodeBinArray, decodeBitmapExtension } from "../decoders/meteora_dlmm";
import { decodeDammV2Raw } from "../decoders/meteora_damm_v2";
import type { DlmmQuoteState } from "./dlmm";
import type { Clock } from "./types";

/** A depth snapshot file (written by `npm run snapshot`) decoded into ready-to-quote pool states, keyed by watchlist label. */
export type DepthSnapshot = {
  slot: number;
  fetchedAt: string;
  clock: Clock;
  /** mint address -> decimals */
  decimals: Map<string, number>;
  dlmm: Map<string, DlmmQuoteState>;
  damm: Map<string, { address: string; state: PoolState }>;
};

type SnapshotAccount = { kind: string; label: string; address: string; index?: number; missing?: boolean; dataBase64?: string };

export function loadDepthSnapshot(path: string): DepthSnapshot {
  const file = JSON.parse(readFileSync(path, "utf8")) as { slot: number; fetchedAt: string; accounts: SnapshotAccount[] };
  const bytes = (a: SnapshotAccount) => Buffer.from(a.dataBase64 ?? "", "base64");
  const out: DepthSnapshot = {
    slot: file.slot,
    fetchedAt: file.fetchedAt,
    clock: { slot: file.slot, unixTime: Math.floor(Date.parse(file.fetchedAt) / 1000) },
    decimals: new Map(), dlmm: new Map(), damm: new Map(),
  };
  for (const a of file.accounts) {
    if (a.missing) continue;
    if (a.kind === "mint") out.decimals.set(a.address, bytes(a)[44]); // SPL Mint layout: decimals byte at offset 44
    else if (a.kind === "damm_pool") out.damm.set(a.label, { address: a.address, state: decodeDammV2Raw(bytes(a)) });
    else if (a.kind === "dlmm_pool") out.dlmm.set(a.label, { address: a.address, lbPair: decodeDlmmRaw(bytes(a)), bitmapExtension: null, binArrays: new Map() });
  }
  // Second pass: bin arrays and bitmap extensions attach to their pool (pools come first in the file, but do not rely on it).
  for (const a of file.accounts) {
    if (a.missing) continue;
    const pool = out.dlmm.get(a.label);
    if (a.kind === "bin_array" && pool && a.index !== undefined) pool.binArrays.set(a.index, decodeBinArray(bytes(a)));
    if (a.kind === "bitmap_ext" && pool) pool.bitmapExtension = decodeBitmapExtension(bytes(a));
  }
  return out;
}
