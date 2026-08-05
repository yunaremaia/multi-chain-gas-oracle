/**
 * Multi-Chain Gas Oracle — Agent Service
 * Real-time gas prices across EVM chains via public RPCs.
 * Entry points: gas (paid), gas_multi (paid), health (free).
 */

import { z } from "zod";
import { createAgentApp } from "@lucid-dreams/agent-kit";

// ── Cache ──
const gasCache: Record<string, { at: number; data: any }> = {};
const CACHE_TTL = 30_000; // 30s (gas changes fast)

export function resetCache(): void {
  Object.keys(gasCache).forEach((k) => delete gasCache[k]);
}

// ── Chain RPCs ──
const CHAINS: Record<string, { rpc: string; name: string; nativeCurrency: string; decimals: number; explorer: string }> = {
  ethereum: { rpc: "https://eth.llamarpc.com", name: "Ethereum", nativeCurrency: "ETH", decimals: 18, explorer: "etherscan.io" },
  base: { rpc: "https://mainnet.base.org", name: "Base", nativeCurrency: "ETH", decimals: 18, explorer: "basescan.org" },
  arbitrum: { rpc: "https://arb1.arbitrum.io/rpc", name: "Arbitrum", nativeCurrency: "ETH", decimals: 18, explorer: "arbiscan.io" },
  optimism: { rpc: "https://mainnet.optimism.io", name: "Optimism", nativeCurrency: "ETH", decimals: 18, explorer: "optimistic.etherscan.io" },
  polygon: { rpc: "https://polygon-rpc.com", name: "Polygon", nativeCurrency: "MATIC", decimals: 18, explorer: "polygonscan.com" },
  bsc: { rpc: "https://bsc-dataseed1.binance.org", name: "BSC", nativeCurrency: "BNB", decimals: 18, explorer: "bscscan.com" },
  avalanche: { rpc: "https://api.avax.network/ext/bc/C/rpc", name: "Avalanche", nativeCurrency: "AVAX", decimals: 18, explorer: "snowtrace.io" },
  optimism_sepolia: { rpc: "https://sepolia.optimism.io", name: "Optimism Sepolia", nativeCurrency: "ETH", decimals: 18, explorer: "sepolia-optimism.etherscan.io" },
  base_sepolia: { rpc: "https://sepolia.base.org", name: "Base Sepolia", nativeCurrency: "ETH", decimals: 18, explorer: "sepolia.basescan.org" },
};

// ── RPC call ──
async function rpcCall(
  url: string,
  method: string,
  params: any[],
  fetchFn: typeof fetch = fetch,
): Promise<any> {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(8000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// ── Gas price for one chain ──
export async function getGasPrice(
  chain: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ chain: string; gasPriceGwei: number; gasPriceWei: string; nativeCurrency: string } | null> {
  const key = chain.toLowerCase();
  if (gasCache[key] && Date.now() - gasCache[key].at < CACHE_TTL) return gasCache[key].data;

  const chainInfo = CHAINS[key];
  if (!chainInfo) return null;

  try {
    const hexGas = await rpcCall(chainInfo.rpc, "eth_gasPrice", []);
    const wei = BigInt(hexGas);
    const gwei = Number(wei) / 1e9;
    const result = {
      chain: chainInfo.name,
      gasPriceGwei: Math.round(gwei * 10000) / 10000,
      gasPriceWei: wei.toString(),
      nativeCurrency: chainInfo.nativeCurrency,
    };
    gasCache[key] = { at: Date.now(), data: result };
    return result;
  } catch {
    return null;
  }
}

// ── Gas estimation for a tx ──
export async function estimateGasCost(
  chain: string,
  gasLimit: number,
  fetchFn: typeof fetch = fetch,
): Promise<{ chain: string; gasLimit: number; costWei: string; costNative: number; costUsd?: number } | null> {
  const gas = await getGasPrice(chain, fetchFn);
  if (!gas) return null;
  const chainInfo = CHAINS[chain.toLowerCase()];
  const costWei = BigInt(gas.gasPriceWei) * BigInt(gasLimit);
  return {
    chain: gas.chain,
    gasLimit,
    costWei: costWei.toString(),
    costNative: Number(costWei) / Math.pow(10, chainInfo?.decimals ?? 18),
  };
}

// ── Agent App ──
const { app, addEntrypoint }: { app: any; addEntrypoint: any } = createAgentApp({
  name: "multi-chain-gas-oracle",
  version: "1.0.0",
  description: "Real-time gas prices across EVM chains for AI agents.",
});

addEntrypoint({
  key: "gas",
  description: "Get current gas price for one EVM chain",
  price: process.env.DEFAULT_PRICE ?? "0.001",
  input: z.object({
    chain: z.string().min(1).max(20).describe("Chain: ethereum, base, arbitrum, optimism, polygon, bsc, avalanche"),
  }),
  async handler({ input }: { input: any }) {
    const result = await getGasPrice(input.chain);
    if (!result) return { output: { error: "chain not found or RPC unreachable" } };
    return { output: result };
  },
});

addEntrypoint({
  key: "gas_multi",
  description: "Get gas prices across multiple chains at once",
  price: process.env.DEFAULT_PRICE ?? "0.002",
  input: z.object({
    chains: z
      .array(z.string().max(20))
      .min(1)
      .max(8)
      .describe("Chains: ethereum, base, arbitrum, optimism, polygon, bsc, avalanche"),
  }),
  async handler({ input }: { input: any }) {
    const results = await Promise.all(input.chains.map((c: string) => getGasPrice(c)));
    const chainNames = Object.keys(CHAINS);
    return {
      output: {
        gas: results.filter(Boolean),
        supported_chains: chainNames,
      },
    };
  },
});

addEntrypoint({
  key: "health",
  description: "Health check",
  input: z.object({}),
  async handler() {
    return {
      output: {
        ok: true,
        timestamp: new Date().toISOString(),
        supported_chains: Object.keys(CHAINS),
        endpoints: ["gas", "gas_multi"],
      },
    };
  },
});

// Discovery
app.get("/.well-known/x402.json", (c: any) =>
  c.json({
    name: "multi-chain-gas-oracle",
    description: "Real-time gas prices across EVM chains for AI agents.",
    version: "1.0.0",
    payTo: process.env.ADDRESS ?? "",
    network: "base",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    endpoints: [
      { key: "gas", path: "/entrypoints/gas/invoke", method: "POST", price: "0.001", description: "Gas price for one chain" },
      { key: "gas_multi", path: "/entrypoints/gas_multi/invoke", method: "POST", price: "0.002", description: "Gas prices across multiple chains" },
      { key: "health", path: "/entrypoints/health/invoke", method: "POST", price: "0", description: "Health check" },
    ],
  }),
);

// OpenAPI discovery
app.get("/openapi.json", (c: any) => {
  const spec = {
    openapi: "3.0.3",
    info: { title: "Multi-Chain Gas Oracle", version: "1.0.0" },
    servers: [{ url: "https://multi-chain-gas-oracle.vercel.app" }],
    paths: {
      "/entrypoints/gas/invoke": {
        post: {
          summary: "Real-time gas prices for an EVM chain",
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "Gas prices" }, "402": { description: "x402 payment required" } },
        },
      },
      "/entrypoints/gas_multi/invoke": {
        post: {
          summary: "Real-time gas prices across multiple EVM chains",
          requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          responses: { "200": { description: "Gas prices" }, "402": { description: "x402 payment required" } },
        },
      },
    },
  };
  return c.json(spec);
});

// llms.txt
app.get("/llms.txt", (c: any) => {
  const lines = [
    "# Multi-Chain Gas Oracle",
    "> multi-chain-gas-oracle.vercel.app",
    "",
    "Real-time gas prices across 9 EVM chains (Ethereum, Base, Arbitrum, Optimism, Polygon, BSC, Avalanche, testnets) via public RPCs.",
    "",
    "## Endpoints (x402, USDC on Base)",
    "",
    '- POST /entrypoints/gas/invoke - input: {"chain":"ethereum"} - $0.001/call',
    '- POST /entrypoints/gas_multi/invoke - input: {"chains":["ethereum","base","arbitrum"]} - $0.002/call',
    "- POST /entrypoints/health/invoke - free",
    "",
    "No API keys, no signup. Discovery: /.well-known/x402.json",
  ];
  return c.text(lines.join("\n"));
});

export default app;
