export type Venue = "dlmm" | "damm";
export type PoolCfg = { token: string; label: string; venue: Venue; address: string };

// The six watchlist pools from the Step 2 record. Add pools here; the logger groups them by token.
export const WATCHLIST: PoolCfg[] = [
  { token: "PERPSPAD", label: "PERPSPAD dlmm80", venue: "dlmm", address: "EHqk4Fw3pTCf9UW75dWoCMf6a2GxyJ8FGYEj2Qmw9rfr" },
  { token: "PERPSPAD", label: "PERPSPAD damm",   venue: "damm", address: "84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ" },
  { token: "PEPE",     label: "PEPE dlmm80",     venue: "dlmm", address: "C1baVnbBd31ucGqvuKgeghtyX6Xpnq5cXxamLqXi9hVN" },
  { token: "PEPE",     label: "PEPE dlmm20",     venue: "dlmm", address: "HDojZeCdUee8nczxsc9MeiMKVF961HqEFeKEvHw74xVR" },
  { token: "PEPE",     label: "PEPE damm1",      venue: "damm", address: "GRNVafZv78DndVua7phP9BFGmmFxJ9r58wBEakDyfsCg" },
  { token: "PEPE",     label: "PEPE damm2",      venue: "damm", address: "ED6PwhyCQ52CQa9V58yy9BTVi9NdVCSVAWWiL1ZzAXhX" },
];

// Pools charging more than this right now are excluded from pairing (launch-fee traps like PEPE damm1 at 4,500 bps).
export const MAX_FEE_BPS = 500;

export const WSOL = "So11111111111111111111111111111111111111112";