import { Connection, PublicKey } from "@solana/web3.js";
import { WATCHLIST, WSOL, type PoolCfg } from "../config/watchlist";
import { decodeDlmmRaw, decodeBitmapExtension } from "../decoders/meteora_dlmm";
import { decodeDammV2Raw } from "../decoders/meteora_damm_v2";
import { binArrayAddress, binArrayIndexesBothWays, bitmapExtensionAddress } from "./dlmm_accounts";

export type AccountKind = "dlmm_pool" | "damm_pool" | "bitmap_ext" | "bin_array" | "mint";
/** One account as stored in a snapshot file. A bitmap extension that does not exist is kept as { missing: true }. */
export type RawAccount = {
  kind: AccountKind; label: string; address: string; index?: number;
  missing?: boolean; owner?: string; lamports?: number; bytes?: number; dataBase64?: string;
};
export type RawSnapshot = { slot: number; fetchedAt: string; arraysPerSide: number; accounts: RawAccount[] };

type Want = { kind: AccountKind; label: string; address: string; index?: number };
const short = (s: string) => `${s.slice(0, 4)}...${s.slice(-4)}`;

/** From the pool accounts, work out every other account the quotes need. */
function wantedAccounts(pools: PoolCfg[], poolData: Map<string, Buffer>, extData: Map<string, Buffer | null>, arraysPerSide: number): Want[] {
  const wants: Want[] = [];
  const mints = new Set<string>();
  for (const p of pools) {
    const data = poolData.get(p.address);
    if (!data) throw new Error(`${p.label} account not found`);
    wants.push({ kind: p.venue === "dlmm" ? "dlmm_pool" : "damm_pool", label: p.label, address: p.address });
    if (p.venue === "dlmm") {
      const lb = decodeDlmmRaw(data);
      const extAddress = bitmapExtensionAddress(new PublicKey(p.address)).toBase58();
      const ext = extData.get(extAddress);
      wants.push({ kind: "bitmap_ext", label: p.label, address: extAddress });
      for (const index of binArrayIndexesBothWays(lb, ext ? decodeBitmapExtension(ext) : null, arraysPerSide))
        wants.push({ kind: "bin_array", label: p.label, address: binArrayAddress(new PublicKey(p.address), index).toBase58(), index });
      mints.add(lb.tokenXMint.toBase58()); mints.add(lb.tokenYMint.toBase58());
    } else {
      const pool = decodeDammV2Raw(data);
      mints.add(pool.tokenAMint.toBase58()); mints.add(pool.tokenBMint.toBase58());
    }
  }
  for (const m of mints) wants.push({ kind: "mint", label: m === WSOL ? "SOL" : short(m), address: m });
  return wants;
}

/**
 * Everything a depth-aware quote needs for a list of pools (the watchlist by default), read at ONE slot: each pool, the bin arrays a DLMM swap
 * could walk (arraysPerSide each way), each DLMM pool's bitmap extension, and the mints. Two passes: pools first,
 * to learn which bin arrays to ask for; then everything in one request. If a pool moved far enough in between to
 * need another bin array, ask again with the fresh state (a few tries at most).
 */
export async function fetchDepthSnapshot(conn: Connection, arraysPerSide = 3, say: (msg: string) => void = () => {}, pools: PoolCfg[] = WATCHLIST): Promise<RawSnapshot> {
  const dlmmPools = pools.filter((p) => p.venue === "dlmm");
  const poolKeys = pools.map((p) => p.address);
  const extKeys = dlmmPools.map((p) => bitmapExtensionAddress(new PublicKey(p.address)).toBase58());

  const first = await conn.getMultipleAccountsInfo([...poolKeys, ...extKeys].map((k) => new PublicKey(k)));
  let poolData = new Map<string, Buffer>();
  let extData = new Map<string, Buffer | null>();
  poolKeys.forEach((k, i) => { if (first[i]) poolData.set(k, Buffer.from(first[i]!.data)); });
  extKeys.forEach((k, i) => { const info = first[poolKeys.length + i]; extData.set(k, info ? Buffer.from(info.data) : null); });

  let wants = wantedAccounts(pools, poolData, extData, arraysPerSide);
  for (let attempt = 1; ; attempt++) {
    const { context, value } = await conn.getMultipleAccountsInfoAndContext(wants.map((w) => new PublicKey(w.address)));
    const byAddress = new Map(wants.map((w, i) => [w.address, value[i]] as const));
    poolData = new Map<string, Buffer>();
    extData = new Map<string, Buffer | null>();
    for (const k of poolKeys) { const info = byAddress.get(k); if (info) poolData.set(k, Buffer.from(info.data)); }
    for (const k of extKeys) { const info = byAddress.get(k); extData.set(k, info ? Buffer.from(info.data) : null); }
    const fresh = wantedAccounts(pools, poolData, extData, arraysPerSide);
    const stillNeeded = fresh.filter((w) => !byAddress.has(w.address));
    if (stillNeeded.length > 0) {
      if (attempt >= 4) throw new Error(`pools kept moving: still missing ${stillNeeded.map((m) => `${m.label} #${m.index}`).join(", ")}`);
      say(`attempt ${attempt}: ${stillNeeded.length} more account(s) needed after a price move, asking again`);
      wants = fresh;
      continue;
    }
    const gone = wants.filter((w, i) => !value[i] && w.kind !== "bitmap_ext");
    if (gone.length) throw new Error(`accounts missing: ${gone.map((m) => `${m.kind} ${m.label} ${m.address}`).join("; ")}`);
    const accounts: RawAccount[] = wants.map((w, i) => {
      const info = value[i];
      return info
        ? { ...w, owner: info.owner.toBase58(), lamports: info.lamports, bytes: info.data.length, dataBase64: Buffer.from(info.data).toString("base64") }
        : { ...w, missing: true };
    });
    return { slot: context.slot, fetchedAt: new Date().toISOString(), arraysPerSide, accounts };
  }
}
