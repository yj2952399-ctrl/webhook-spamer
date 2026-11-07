export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const now = () => Date.now();

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export function rand(n = 8) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((b) => (b % 36).toString(36)).join("");
}

export const hex = (buf) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export function unhex(s) {
  const clean = String(s || "").replace(/[^0-9a-f]/gi, "");
  if (clean.length < 2) return new Uint8Array(0);
  const pairs = clean.match(/.{2}/g) || [];
  return new Uint8Array(pairs.map((h) => parseInt(h, 16)));
}

export function cookie(req, name) {
  for (const p of (req.headers.get("cookie") || "").split(";")) {
    const [k, ...v] = p.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : dflt;
};

export const urlOk = (s) => /^https?:\/\/[^\s]+$/i.test(String(s || "").trim());

export const SESSION_TTL = 30 * 864e5;