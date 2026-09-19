import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeDlmmPool } from "./decoders/meteora_dlmm";

const f = JSON.parse(readFileSync(join(__dirname, "..", "test", "fixtures", "dlmm_pool.json"), "utf8"));
const state = decodeDlmmPool(f.address, Buffer.from(f.dataBase64, "base64"), 6, 9);
console.log("fixture slot:", f.slot);
console.log(JSON.stringify(state, null, 2));