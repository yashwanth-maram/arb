import { Connection, PublicKey } from "@solana/web3.js";
import { decodeDlmmPool } from "./decoders/meteora_dlmm";
import { decodeDammV2Pool } from "./decoders/meteora_damm_v2";
import { gapNetOfFees } from "./scanner/gap";

const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const DLMM = new PublicKey("EHqk4Fw3pTCf9UW75dWoCMf6a2GxyJ8FGYEj2Qmw9rfr");
const DAMM = new PublicKey("84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ");

async function main() {
  const conn = new Connection(RPC, "processed");
  const { context, value } = await conn.getMultipleAccountsInfoAndContext([DLMM, DAMM]);
  const [a, b] = value;
  if (!a || !b) throw new Error("pool account missing on this RPC");
  const d = decodeDlmmPool(DLMM.toBase58(), Buffer.from(a.data), 6, 9);
  const v = decodeDammV2Pool(DAMM.toBase58(), Buffer.from(b.data), 6, 9);
  const g = gapNetOfFees(d.price, d.totalFeeBps, v.price, v.totalFeeBps);
  console.log(`${RPC}  slot ${context.slot}`);
  console.log(`DLMM   activeId ${d.activeId}  price ${d.price.toPrecision(8)}  fee ${d.totalFeeBps.toFixed(3)} bps`);
  console.log(`DAMMv2 price ${v.price.toPrecision(8)}  fee ${v.totalFeeBps.toFixed(3)} bps`);
  console.log(`gap ${g.gapPct.toFixed(3)}%  floor ${g.feeFloorPct.toFixed(3)}%  net ${g.netPct.toFixed(3)}%  ${g.direction}`);
}

main().catch((e) => { console.error(e); process.exit(1); });