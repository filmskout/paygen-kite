# PayGen — Agent-Verified, Pay-per-Call AI Creation (MCP + x402)

> AI³ Growth Hackathon · Track: **Kite — Make It Agent-Payable** · Reference project #2: *"API/MCP server with agent identity verification and pay-per-call billing"*

**PayGen** turns AI creation (image generation, poem cards) into an **agent-payable merchant**: any external agent must present payment (Kite x402 protocol, kite-testnet PIEUSD) before each call. Every call is identity-attributed, priced per-use, and logged in an auditable merchant ledger.

一句话:把生图/创作能力包成 **MCP server + x402 商户**,外部 agent 出示支付凭证按次付费($0.10/图、$0.01/诗),商户侧核验→结算→交付,全程流水可审计。

## Live demo

**https://ww.storyard.ai:8443/paygen/** — left panel is a "buyer agent" with a budget; right panel shows the merchant ledger. Click 买一张图 → identity check → **real on-chain charge of $0.10 PIEUSD (kite-testnet)** → real image generated (gpt-image-2 via apilio). The hero banner at the top of the page is itself an image purchased through this exact flow.

## Two integration surfaces

### 1. MCP (streamable HTTP, JSON-RPC)

```bash
POST /paygen/mcp
{"jsonrpc":"2.0","id":1,"method":"tools/list"}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{
  "name":"generate_image",
  "arguments":{"prompt":"a kite over the sea","_payment":"<base64 x402 payload>"}}}
```

Tools: `generate_image` ($0.10/call) · `generate_poem_card` ($0.01/call). Price and payment instructions are embedded in each tool's description so agent frameworks surface them automatically.

### 2. HTTP x402 (protocol-native)

```
GET /paygen/api/generate_image?prompt=...
← 402 {accepts:[{scheme:"exact", network:"eip155:2368", asset:PIEUSD, payTo:..., maxAmountRequired:...}]}
→ retry with X-Payment: <base64 authorization>
← 200 {payment:{tx}, result:{url}}   + X-Payment-Response header
```

Settlement flow (when live): merchant → Pieverse facilitator `/v2/verify` → `/v2/settle` (EIP-3009 `transferWithAuthorization`) → deliver. Network `eip155:2368` (Kite testnet), asset PIEUSD `0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A`.

## What's real vs simulated

| Piece | Status |
|---|---|
| Image generation (apilio gpt-image-2) | ✅ real, every purchase produces a real image |
| 402 terms / X-Payment / MCP protocol surfaces | ✅ real, protocol-conformant |
| Facilitator verify/settle code path | ✅ implemented (`SIM_PAY=0`) |
| On-chain settlement in demo | ✅ **REAL** (`SIM_PAY=0` in production): buyer signs EIP-3009, merchant settles via Pieverse facilitator on kite-testnet — every purchase is a block-confirmed PIEUSD transfer with a kitescan link |
| Merchant ledger / audit | ✅ real (in-memory, per-run) |

## Run

```bash
# env: APILIO_API_KEY, APILIO_BASE_URL (image backend); PAY_TO (your wallet)
SIM_PAY=0 PORT=4030 PAY_TO=<merchant addr> node server.mjs   # REAL x402 settlement via Pieverse (production demo)
SIM_PAY=1 PORT=4030 node server.mjs                          # offline simulated mode
open http://localhost:4030
```

Zero npm dependencies. Node ≥ 20.

## Architecture

```
buyer agent (Kite Passport, budget)
   │  MCP tools/call + _payment      │  HTTP GET + X-Payment
   ▼                                 ▼
PayGen merchant ──► verify (identity+payment) ──► Pieverse facilitator (kite-testnet)
   │ settled                                        /v2/verify → /v2/settle
   ▼
apilio /v1/images/generations (gpt-image-2) ──► deliver + ledger entry
```

## Iteration plan

- Kite catalog allowlisting → agents pay via `kpass agent:session execute` directly.
- More tools: MV storyboard frames, meme generation (existing BigApple workbenches).
- Per-agent pricing tiers & subscription credits; on-chain receipt anchoring.

## Sister projects

- **QuantScout** (A1) — the flagship buyer: an autonomous quant-research agent that spends its budget on data (this repo's x402 merchant pattern is its data vendor `market402`).
- **AgentLedger** (A3) — owner-side dashboard supervising both agents' budgets and ledgers.

---
*Team BigApple · AI³ Growth Hackathon 2026 · Kite track*
