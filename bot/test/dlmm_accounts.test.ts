import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { decodeDlmmRaw } from "../src/decoders/meteora_dlmm";
import { binArrayAddress, binArrayIndexesBothWays, binArrayIndexesForSwap, bitmapExtensionAddress } from "../src/quoter/dlmm_accounts";

// PERPSPAD DLMM pool at slot 448334506: active bin -375, which lives in bin array -6 (bins -420..-351).
const f = JSON.parse(readFileSync(resolve("test/fixtures/dlmm_pool.json"), "utf8"));
const lbPair = decodeDlmmRaw(Buffer.from(f.dataBase64, "base64"));
const pool = new PublicKey(f.address);

describe("DLMM bin arrays a swap would walk (fixture slot 448334506)", () => {
  it("starts in the array holding the active bin and walks away from it, following the pool's liquidity bitmap", () => {
    expect(binArrayIndexesForSwap(lbPair, null, true, 3)).toEqual([-6, -7, -8]);  // selling X: price falls
    expect(binArrayIndexesForSwap(lbPair, null, false, 3)).toEqual([-6, -5, -4]); // buying X: price rises
  });

  it("lists each array once when both directions are wanted", () => {
    expect(binArrayIndexesBothWays(lbPair, null, 3)).toEqual([-8, -7, -6, -5, -4]);
    expect(binArrayIndexesBothWays(lbPair, null, 1)).toEqual([-6]);
  });

  it("derives the on-chain addresses of those accounts", () => {
    expect(binArrayAddress(pool, -6).toBase58()).toBe("5tQ8iDNnFw7opDb5YhpfyjprGaaKnrtpeavHwuHfUUaj");
    expect(binArrayAddress(pool, -5).toBase58()).toBe("CgLF6bgTsv35Vh1CdPHjrZUHyocMxz2AEKqRY1ivqnWB");
    expect(bitmapExtensionAddress(pool).toBase58()).toBe("3puEFy4zEqQnrLNC83nAhWAHX6huLBjvouTt2bwMcZtL");
  });
});
