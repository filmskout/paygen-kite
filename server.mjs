/**
 * PayGen — agent 身份核验 + 按次付费的 AI 创作服务(Kite x402 merchant)
 * AI³ Hackathon · Kite track · 参考项目第2条: "支持 agent 身份核验和按次付费的 API/MCP server"
 *
 * 双入口:
 *   HTTP x402:  GET/POST /api/generate_image, /api/generate_poem_card
 *               无 X-PAYMENT → 402+条款(kite-testnet PIEUSD);有 → Pieverse verify/settle → 生成
 *   MCP:        POST /mcp (streamable HTTP, JSON-RPC): tools/list, tools/call
 *               MCP 调用方在 arguments._payment 里带支付凭证(x402 同款 base64)
 *
 * 生图: apilio /v1/images/generations (gpt-image-2) — env APILIO_API_KEY/APILIO_BASE_URL
 * 演示模式: SIM_PAY=1 时跳过 facilitator,记 simulated 流水(买家页开箱即用)
 *
 * 用法: source ../../signal-duel/.env.local && PORT=4030 SIM_PAY=1 node server.mjs
 */
import http from "node:http";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4030;
const SIM_PAY = process.env.SIM_PAY === "1";
const PAY_TO = process.env.PAY_TO || "0x5BdF76D1741403921A3235B53Cb612ae0B3C2F35";
const PIEUSD = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A";
const NETWORK = "eip155:2368"; // kite-testnet
const FACILITATOR = process.env.FACILITATOR || "https://facilitator.pieverse.io";
const APILIO_BASE = (process.env.APILIO_BASE_URL || "https://api.apilio.ai").replace(/\/$/, "");
const APILIO_KEY = process.env.APILIO_API_KEY?.trim();
const IMG_DIR = path.join(__dirname, "generated"); mkdirSync(IMG_DIR, { recursive: true });

// 工具定价(raw 18 decimals PIEUSD)
const TOOLS = {
  generate_image:     { price: "100000000000000000", priceHuman: "0.10", desc: "Generate an image from a prompt (gpt-image-2 via apilio)" },
  generate_poem_card: { price: "10000000000000000",  priceHuman: "0.01", desc: "Generate a short Chinese poem card (text)" },
};

const ledger = []; // {ts,seq,tool,payer,amount,tx,simulated,status}

function terms(tool, resource) {
  const t = TOOLS[tool];
  return { scheme: "exact", network: NETWORK, maxAmountRequired: t.price, resource, description: t.desc,
    mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 240, asset: PIEUSD,
    extra: { name: "pieUSD", version: "1", merchantName: "PayGen" } };
}

async function facilitate(pathname, payload, requirements) {
  const res = await fetch(FACILITATOR + pathname, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }) });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

/** 核验身份 + 结算。返回 {payer, tx, simulated} 或抛错 */
async function settle(tool, xPaymentB64, resource) {
  if (SIM_PAY) {
    const payer = xPaymentB64 ? "agent:" + xPaymentB64.slice(0, 12) : "agent:demo-buyer";
    const rec = { ts: Date.now(), seq: ledger.length + 1, tool, payer, amount: TOOLS[tool].priceHuman,
      tx: "0xSIM" + Date.now().toString(16), simulated: true, status: "settled" };
    ledger.push(rec); return rec;
  }
  if (!xPaymentB64) { const e = new Error("payment required"); e.code = 402; throw e; }
  let payload;
  try { payload = JSON.parse(Buffer.from(xPaymentB64, "base64").toString("utf8")); }
  catch { const e = new Error("invalid X-PAYMENT encoding"); e.code = 400; throw e; }
  const req2 = terms(tool, resource);
  const v = await facilitate("/v2/verify", payload, req2);
  if (!v.ok || v.body.isValid === false) { const e = new Error("verification failed: " + JSON.stringify(v.body).slice(0, 200)); e.code = 402; throw e; }
  const s = await facilitate("/v2/settle", payload, req2);
  if (!s.ok || s.body.success === false) { const e = new Error("settlement failed: " + JSON.stringify(s.body).slice(0, 200)); e.code = 402; throw e; }
  const payer = payload?.payload?.authorization?.from || payload?.from || "unknown";
  const rec = { ts: Date.now(), seq: ledger.length + 1, tool, payer, amount: TOOLS[tool].priceHuman,
    tx: s.body.transaction || s.body.txHash || null, simulated: false, status: "settled" };
  ledger.push(rec); return rec;
}

// —— 创作实现 ——
async function generateImage(prompt) {
  if (!APILIO_KEY) throw new Error("APILIO_API_KEY not configured");
  const r = await fetch(`${APILIO_BASE}/v1/images/generations`, {
    method: "POST", headers: { Authorization: `Bearer ${APILIO_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-image-2", prompt, size: "1024x1024", n: 1 }),
    signal: AbortSignal.timeout(240_000),
  });
  if (!r.ok) throw new Error(`apilio ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  const item = d.data?.[0];
  let b64 = item?.b64_json;
  if (!b64 && item?.url) {
    const dl = await fetch(item.url, { signal: AbortSignal.timeout(120_000) });
    b64 = Buffer.from(await dl.arrayBuffer()).toString("base64");
  }
  if (!b64) throw new Error("apilio returned no image");
  const fn = `img_${Date.now()}.png`;
  writeFileSync(path.join(IMG_DIR, fn), Buffer.from(b64, "base64"));
  return { file: fn, url: `generated/${fn}` };
}

function generatePoemCard(theme) {
  const lines = {
    default: ["山色有无中", "帆影入云空", "代理持信步", "链上自从容"],
    kite:    ["纸鸢乘风起", "代理自遨游", "预算方寸内", "信用链上留"],
    quant:   ["K线如山峦", "均线似水流", "回测千百遍", "风控是根由"],
  };
  const pick = /kite|风筝/i.test(theme) ? "kite" : /quant|量化/i.test(theme) ? "quant" : "default";
  return { theme, poem: lines[pick], footer: "— PayGen · pay-per-poem · Kite x402" };
}

// —— MCP (streamable HTTP, 最小 JSON-RPC 实现) ——
async function handleMcp(body) {
  const { id, method, params } = body;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "paygen", version: "1.0.0" } });
  if (method === "notifications/initialized") return null;
  if (method === "tools/list") return reply({ tools: [
    { name: "generate_image", description: `${TOOLS.generate_image.desc}. Price: $${TOOLS.generate_image.priceHuman} PIEUSD per call (x402; pass base64 payment in _payment).`,
      inputSchema: { type: "object", properties: { prompt: { type: "string" }, _payment: { type: "string", description: "base64 x402 payment payload" } }, required: ["prompt"] } },
    { name: "generate_poem_card", description: `${TOOLS.generate_poem_card.desc}. Price: $${TOOLS.generate_poem_card.priceHuman} PIEUSD per call.`,
      inputSchema: { type: "object", properties: { theme: { type: "string" }, _payment: { type: "string" } }, required: ["theme"] } },
  ] });
  if (method === "tools/call") {
    const { name, arguments: args = {} } = params || {};
    if (!TOOLS[name]) return fail(-32602, "unknown tool " + name);
    try {
      const pay = await settle(name, args._payment, `mcp://paygen/${name}`);
      const out = name === "generate_image" ? await generateImage(args.prompt || "a kite in the sky")
                                            : generatePoemCard(args.theme || "kite");
      return reply({ content: [{ type: "text", text: JSON.stringify({ payment: { tx: pay.tx, amount: pay.amount, simulated: pay.simulated }, result: out }) }] });
    } catch (e) { return fail(e.code === 402 ? -32001 : -32000, e.message); }
  }
  return fail(-32601, "method not found: " + method);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const send = (code, obj, hdr = {}) => { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", ...hdr }); res.end(JSON.stringify(obj)); };
  const body = await new Promise((ok) => { let b = ""; req.on("data", (c) => b += c); req.on("end", () => ok(b)); });

  if (u.pathname === "/" || u.pathname === "/index.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(readFileSync(path.join(__dirname, "public", "index.html"))); }
  if (u.pathname.startsWith("/generated/")) {
    const f = path.join(IMG_DIR, path.basename(u.pathname));
    if (existsSync(f)) { res.writeHead(200, { "Content-Type": "image/png" }); return res.end(readFileSync(f)); }
    return send(404, { error: "gone" });
  }
  if (u.pathname === "/health") return send(200, { ok: true, service: "paygen", network: NETWORK, simPay: SIM_PAY, tools: Object.fromEntries(Object.entries(TOOLS).map(([k, v]) => [k, "$" + v.priceHuman])) });
  if (u.pathname === "/ledger") return send(200, { count: ledger.length, ledger });

  if (u.pathname === "/mcp" && req.method === "POST") {
    try { const out = await handleMcp(JSON.parse(body || "{}")); return out ? send(200, out) : send(202, {}); }
    catch (e) { return send(400, { error: e.message }); }
  }

  const m = u.pathname.match(/^\/api\/(generate_image|generate_poem_card)$/);
  if (m) {
    const tool = m[1];
    const xp = req.headers["x-payment"];
    if (!xp && !SIM_PAY) return send(402, { x402Version: 2, error: "payment required", accepts: [terms(tool, `http://ww.storyard.ai:8443/paygen/api/${tool}`)] });
    try {
      const pay = await settle(tool, xp, `http://ww.storyard.ai:8443/paygen/api/${tool}`);
      const args = body ? JSON.parse(body) : Object.fromEntries(u.searchParams);
      const out = tool === "generate_image" ? await generateImage(args.prompt || "a kite in the sky")
                                            : generatePoemCard(args.theme || "kite");
      return send(200, { payment: { tx: pay.tx, amount: pay.amount, simulated: pay.simulated }, result: out },
        { "X-Payment-Response": Buffer.from(JSON.stringify({ tx: pay.tx })).toString("base64") });
    } catch (e) { return send(e.code || 500, { error: e.message, ...(e.code === 402 ? { accepts: [terms(tool, u.pathname)] } : {}) }); }
  }
  send(404, { error: "not found" });
});
server.listen(PORT, () => console.log(`PayGen on :${PORT} SIM_PAY=${SIM_PAY} apilio=${APILIO_KEY ? "configured" : "MISSING"}`));
