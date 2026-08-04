import { describe, it, expect, vi, beforeEach } from "vitest";
import app, { getGasPrice, resetCache } from "../src/index.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function rpcResponse(gwei: number): any {
  const wei = BigInt(Math.round(gwei * 1e9));
  return {
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: 1, result: "0x" + wei.toString(16) }),
  };
}

describe("getGasPrice", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCache();
  });

  it("returns gas price for known chain", async () => {
    mockFetch.mockResolvedValueOnce(rpcResponse(0.006));
    const result = await getGasPrice("base", mockFetch);
    expect(result).not.toBeNull();
    expect(result!.chain).toBe("Base");
    expect(result!.gasPriceGwei).toBeCloseTo(0.006, 3);
    expect(result!.nativeCurrency).toBe("ETH");
    expect(result!.gasPriceWei).toBeDefined();
  });

  it("caches within TTL", async () => {
    mockFetch.mockResolvedValueOnce(rpcResponse(0.02));
    await getGasPrice("arbitrum", mockFetch);
    await getGasPrice("arbitrum", mockFetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns null for unknown chain", async () => {
    const result = await getGasPrice("unknown_chain", mockFetch);
    expect(result).toBeNull();
  });

  it("returns null on RPC error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("timeout"));
    const result = await getGasPrice("ethereum", mockFetch);
    expect(result).toBeNull();
  });
});

describe("Agent entrypoints", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetCache();
  });

  it("/health returns 200", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.ok).toBe(true);
  });

  it("x402: gas invoke without payment -> 402", async () => {
    const res = await app.request("/entrypoints/gas/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { chain: "base" } }),
    });
    expect(res.status).toBe(402);
    const body: any = await res.json();
    expect(body.accepts[0].payTo).toBeDefined();
  });

  it("x402: gas_multi invoke without payment -> 402", async () => {
    const res = await app.request("/entrypoints/gas_multi/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { chains: ["base", "optimism"] } }),
    });
    expect(res.status).toBe(402);
  });

  it("exposes entrypoints", async () => {
    const res = await app.request("/entrypoints");
    expect(res.status).toBe(200);
    const { items } = await res.json();
    expect(items.map((i: any) => i.key)).toContain("gas");
    expect(items.map((i: any) => i.key)).toContain("gas_multi");
  });
});
