/**
 * x402-buyer — 自签 EIP-3009 的 x402 支付客户端(kite-testnet PIEUSD)
 * 完整真实链路,不依赖 Kite 商户 allowlist:
 *   GET 商户 → 402 条款 → 本地签 transferWithAuthorization(EIP-712)
 *   → 带 X-Payment 重试 → 商户经 Pieverse facilitator verify/settle 上链 → 交付
 *
 * 用法: node buyer.mjs <url> [method] [json-body]
 * env:  BUYER_KEY(默认读 .buyer-key)
 */
import { ethers } from "ethers";
import { readFileSync } from "node:fs";

const PIEUSD = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A";
const DOMAIN = { name: "pieUSD", version: "1", chainId: 2368, verifyingContract: PIEUSD };
const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" }, { name: "to", type: "address" },
    { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
  ],
};

export async function payAndCall(url, { method = "GET", body, keyPath = new URL(".buyer-key", import.meta.url) } = {}) {
  const wallet = new ethers.Wallet(process.env.BUYER_KEY || readFileSync(keyPath, "utf8").trim());
  const opts = { method, headers: {} };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }

  // 1) 先打一枪拿 402 条款
  const r1 = await fetch(url, opts);
  if (r1.status !== 402) return { paid: false, status: r1.status, data: await r1.json().catch(() => null) };
  const terms = (await r1.json()).accepts?.[0];
  if (!terms) throw new Error("402 without accepts terms");

  // 2) 签 EIP-3009 授权
  const now = Math.floor(Date.now() / 1000);
  // EIP-712 签名用数值,payload 里按 x402 v2 类型转字符串
  const authNum = {
    from: wallet.address, to: terms.payTo,
    value: terms.amount,
    validAfter: 0, validBefore: now + (terms.maxTimeoutSeconds || 300),
    nonce: ethers.hexlify(ethers.randomBytes(32)),
  };
  const signature = await wallet.signTypedData(DOMAIN, TYPES, authNum);
  const authorization = { ...authNum, value: String(authNum.value), validAfter: "0", validBefore: String(authNum.validBefore) };

  // 3) x402 v2 PaymentPayload(accepted 携带所选条款)→ base64 X-Payment
  const paymentPayload = {
    x402Version: 2, accepted: terms,
    payload: { signature, authorization },
  };
  const xPayment = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");

  // 4) 重试
  const r2 = await fetch(url, { ...opts, headers: { ...opts.headers, "X-Payment": xPayment } });
  const data = await r2.json().catch(() => null);
  return { paid: r2.ok, status: r2.status, payer: wallet.address, data,
    paymentResponse: r2.headers.get("x-payment-response") };
}

// CLI
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const [url, method = "GET", bodyStr] = process.argv.slice(2);
  if (!url) { console.error("用法: node buyer.mjs <url> [method] [json-body]"); process.exit(1); }
  payAndCall(url, { method, body: bodyStr ? JSON.parse(bodyStr) : undefined })
    .then((r) => console.log(JSON.stringify(r, null, 2)))
    .catch((e) => { console.error("ERR:", e.message); process.exit(1); });
}
