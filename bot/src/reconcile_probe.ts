import { Connection, PublicKey, type ParsedTransactionWithMeta, type ParsedInstruction, type PartiallyDecodedInstruction } from "@solana/web3.js";

// Usage: FROM_SLOT=... TO_SLOT=... tsx src/reconcile_probe.ts
// Lists every transaction that touched the given pools inside the slot range and prints who did what.
try { process.loadEnvFile(".env"); } catch { /* optional */ }
const KEY = process.env.HELIUS_API_KEY;
const RPC = process.env.RPC_HTTP ?? (KEY ? `https://mainnet.helius-rpc.com/?api-key=${KEY}` : "https://api.mainnet-beta.solana.com");
const FROM = Number(process.env.FROM_SLOT);
const TO = Number(process.env.TO_SLOT);
if (!FROM || !TO || TO < FROM) { console.error("set FROM_SLOT and TO_SLOT"); process.exit(1); }

const POOLS: Record<string, string> = {
    "PERPSPAD dlmm80": "EHqk4Fw3pTCf9UW75dWoCMf6a2GxyJ8FGYEj2Qmw9rfr",
    "PERPSPAD damm": "84uf4YpzybB4vm8RsermBFqjGxThAETpyMbp5HvkVRJQ",
};
const PROGRAMS: Record<string, string> = {
    LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora-dlmm",
    cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "meteora-damm-v2",
    JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter-v6",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium-amm",
    CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium-clmm",
    CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium-cpmm",
    whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "orca-whirlpool",
    pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap",
    ComputeBudget111111111111111111111111111111: "compute-budget",
    "11111111111111111111111111111111": "system",
    TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "spl-token",
    ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "ata",
};
// Jito tip accounts (mainnet). A transfer to one of these marks a bundle submission.
const JITO_TIPS = new Set([
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5", "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyi9tJqD3mDBAfmA3GfaJUvv3dfTfr2cEUSnRXZo", "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh", "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL", "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

const short = (s: string) => s.slice(0, 4) + "…" + s.slice(-4);

async function signaturesInRange(conn: Connection, address: PublicKey): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    let before: string | undefined;
    for (let page = 0; page < 20; page++) {
        const sigs = await conn.getSignaturesForAddress(address, { limit: 1000, before }, "confirmed");
        if (sigs.length === 0) break;
        for (const s of sigs) if (s.slot >= FROM && s.slot <= TO) out.set(s.signature, s.slot);
        const oldest = sigs[sigs.length - 1];
        if (oldest.slot < FROM) break;
        before = oldest.signature;
    }
    return out;
}

function describe(tx: ParsedTransactionWithMeta) {
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
    const signer = keys[0];
    const instrs: (ParsedInstruction | PartiallyDecodedInstruction)[] = [
        ...tx.transaction.message.instructions,
        ...(tx.meta?.innerInstructions ?? []).flatMap((ii) => ii.instructions),
    ];
    const programs = new Set<string>();
    let tipLamports = 0;
    for (const ix of instrs) {
        const pid = ix.programId.toBase58();
        programs.add(PROGRAMS[pid] ?? short(pid));
        if ("parsed" in ix && ix.program === "system" && ix.parsed?.type === "transfer") {
            const dest = ix.parsed.info?.destination as string;
            if (JITO_TIPS.has(dest)) tipLamports += Number(ix.parsed.info?.lamports ?? 0);
        }
    }
    const touched = Object.entries(POOLS).filter(([, addr]) => keys.includes(addr)).map(([label]) => label);
    // Signer's SOL and token balance changes tell us the economic result of the transaction.
    const solDelta = tx.meta ? (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / 1e9 : NaN;
    const tokenDeltas: string[] = [];
    const pre = tx.meta?.preTokenBalances ?? [], post = tx.meta?.postTokenBalances ?? [];
    for (const p of post) {
        if (p.owner !== signer) continue;
        const before = pre.find((q) => q.accountIndex === p.accountIndex);
        const d = (p.uiTokenAmount.uiAmount ?? 0) - (before?.uiTokenAmount.uiAmount ?? 0);
        if (d !== 0) tokenDeltas.push(`${short(p.mint)}:${d > 0 ? "+" : ""}${d.toFixed(4)}`);
    }
    return {
        signer, programs: [...programs].filter((p) => !["compute-budget", "system", "spl-token", "ata"].includes(p)),
        touched, tipSol: tipLamports / 1e9, feeSol: (tx.meta?.fee ?? 0) / 1e9,
        cu: tx.meta?.computeUnitsConsumed ?? 0, ok: tx.meta?.err == null, solDelta, tokenDeltas,
    };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
    for (let i = 0; ; i++) {
        try { return await fn(); }
        catch (e) {
            if (i >= tries - 1 || !String((e as Error).message).includes("429")) throw e;
            await sleep(1500 * (i + 1));
        }
    }
}

async function main() {
    const conn = new Connection(RPC, "confirmed");
    const bySig = new Map<string, number>();
    for (const [label, addr] of Object.entries(POOLS)) {
        const m = await signaturesInRange(conn, new PublicKey(addr));
        console.log(`${label}: ${m.size} transactions in slots ${FROM}-${TO}`);
        for (const [sig, slot] of m) bySig.set(sig, slot);
    }
    const sigs = [...bySig.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s);

    // Free-plan friendly: 20 transactions per request, a pause between requests, retry on 429.
    const txs: (ParsedTransactionWithMeta | null)[] = [];
    for (let i = 0; i < sigs.length; i += 20) {
        const chunk = sigs.slice(i, i + 20);
        txs.push(...(await withRetry(() => conn.getParsedTransactions(chunk, { maxSupportedTransactionVersion: 1, commitment: "confirmed" }))));
        await sleep(400);
    }

    const perSlot = new Map<number, { ok: number; err: number }>();
    const perSigner = new Map<string, { ok: number; err: number; tip: number }>();
    console.log(`\nslot        signer         ok  pools touched               programs                 tip SOL   fee SOL   CU      signer SOL Δ   signer token Δ`);
    txs.forEach((tx, i) => {
        if (!tx) { console.log(`${bySig.get(sigs[i])}  ${sigs[i].slice(0, 12)}… (not found)`); return; }
        const d = describe(tx);
        const s = perSlot.get(tx.slot) ?? { ok: 0, err: 0 }; d.ok ? s.ok++ : s.err++; perSlot.set(tx.slot, s);
        const g = perSigner.get(d.signer) ?? { ok: 0, err: 0, tip: 0 }; d.ok ? g.ok++ : g.err++; g.tip += d.tipSol; perSigner.set(d.signer, g);
        if (!d.ok) return; // failed transactions: counted in the summaries, not listed
        console.log(`${tx.slot}  ${short(d.signer).padEnd(14)} ${d.ok ? "ok " : "ERR"} ${d.touched.join("+").padEnd(27)} ${d.programs.join(",").padEnd(24)} ${d.tipSol.toFixed(6)}  ${d.feeSol.toFixed(6)}  ${String(d.cu).padEnd(7)} ${d.solDelta.toFixed(6).padStart(12)}   ${d.tokenDeltas.join(" ")}`);
        console.log(`            sig ${sigs[i]}`);
    });

    console.log(`\nper slot (ok/failed):`);
    for (const [slot, s] of [...perSlot].sort((a, b) => a[0] - b[0])) console.log(`  ${slot}  ok ${s.ok}  failed ${s.err}`);
    console.log(`\nsigners (ok/failed/total tip SOL), busiest first:`);
    for (const [signer, g] of [...perSigner].sort((a, b) => (b[1].ok + b[1].err) - (a[1].ok + a[1].err)).slice(0, 15))
        console.log(`  ${signer}  ok ${g.ok}  failed ${g.err}  tip ${g.tip.toFixed(6)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });