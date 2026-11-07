import { json, rand, hex, unhex, cookie, SESSION_TTL } from "./util.js";

const ITER = 10000; // 無料枠の CPU 10ms に収めるための値

async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(saltHex), iterations: ITER, hash: "SHA-256" }, key, 256);
  return hex(bits);
}

const cookieHeader = (token) => ({
  "set-cookie": `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`,
});

async function openSession(env, userId) {
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)")
    .bind(token, userId, Date.now() + SESSION_TTL).run();
  return token;
}

export async function register(req, env) {
  const { username = "", password = "" } = await req.json().catch(() => ({}));
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    return json({ error: "ユーザー名は英数_ 3〜24文字" }, 400);
  }
  if (String(password).length < 8) return json({ error: "パスワードは8文字以上" }, 400);

  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await hashPw(String(password), salt);

  let id;
  try {
    const r = await env.DB.prepare(
      "INSERT INTO users (username, pw_hash, pw_salt, created_at) VALUES (?,?,?,?)")
      .bind(username, hash, salt, Date.now()).run();
    id = r.meta.last_row_id;
  } catch {
    return json({ error: "そのユーザー名は使用済み" }, 409);
  }

  // 既定値は schema.sql の DEFAULT に任せる（NULL を作らない）
  await env.DB.prepare("INSERT INTO settings (user_id) VALUES (?)").bind(id).run();

  return json({ ok: true }, 200, cookieHeader(await openSession(env, id)));
}

export async function login(req, env) {
  const { username = "", password = "" } = await req.json().catch(() => ({}));
  const u = await env.DB.prepare("SELECT * FROM users WHERE username = ?").bind(username).first();
  if (!u || (await hashPw(String(password), u.pw_salt)) !== u.pw_hash) {
    return json({ error: "認証失敗" }, 401);
  }
  return json({ ok: true }, 200, cookieHeader(await openSession(env, u.id)));
}

export async function logout(req, env) {
  const sid = cookie(req, "sid");
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(sid).run();
  return json({ ok: true }, 200, { "set-cookie": "sid=; Path=/; Max-Age=0" });
}

export async function currentUser(req, env) {
  const sid = cookie(req, "sid");
  if (!sid) return null;
  return await env.DB.prepare(
    `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`).bind(sid, Date.now()).first();
}