import http from "node:http";
import https from "node:https";

/** JSON over IPv4 (IPv6 is dead inside this WSL), with a time limit. Returns the HTTP status with the parsed body. */
export function requestJson(
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = (url.startsWith("https:") ? https : http).request(url, {
      method, family: 4, timeout: 30_000,
      headers: { accept: "application/json", ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}), ...headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: { raw: text.slice(0, 300) } }); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timed out after 30 s")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}
