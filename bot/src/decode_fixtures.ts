import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeDlmmPool } from "./decoders/meteora_dlmm";
import { decodeDammV2Pool } from "./decoders/meteora_damm_v2";

const FIX = join(__dirname, "..", "test", "fixtures");
const load = (label: string) => {
  const f = JSON.parse(readFileSync(join(FIX, `${label}.json`), "utf8"));
  return { address: f.address as string, slot: f.slot as number, data: Buffer.from(f.dataBase64, "base64") };
};

// PERPSPAD has 6 decimals, SOL has 9 (Step 2 record).
const DEC_PERPSPAD = 6, DEC_SOL = 9;

const dlmm = load("dlmm_pool");
const d = decodeDlmmPool(dlmm.address, dlmm.data, DEC_PERPSPAD, DEC_SOL);
console.log("DLMM  slot", dlmm.slot, JSON.stringify(d, null, 2));

const damm = load("damm_pool");
const v = decodeDammV2Pool(damm.address, damm.data, DEC_PERPSPAD, DEC_SOL);
console.log("DAMM2 slot", damm.slot, JSON.stringify(v, null, 2));

const gapPct = ((d.price - v.price) / v.price) * 100;
const feeFloorPct = (d.totalFeeBps + v.totalFeeBps) / 100;
console.log(`\nDLMM price ${d.price}  DAMMv2 price ${v.price}`);
console.log(`gap = ${gapPct.toFixed(3)}%   round-trip fee floor = ${feeFloorPct.toFixed(3)}%   net = ${(Math.abs(gapPct) - feeFloorPct).toFixed(3)}%`);