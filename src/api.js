import { json, clamp } from "./util.js";
import { DEFAULT_SETTINGS } from "./payload.js";

export async function getSettings(env, me) {
  const row = await env.DB.prepare("SELECT * FROM settings WHERE user_id = ?").bind(me.id).first();
  return json({ ...DEFAULT_SETTINGS, ...(row || {}) });
}

export async function putSettings(req, env, me) {
  const b = await req.json().catch(() => ({}));
  const v = { ...DEFAULT_SETTINGS, ...b };
  await env.DB.prepare(
    `UPDATE settings SET content=?,delay=?,jitter=?,concurrency=?,retries=?,ping_everyone=?,
     embed=?,embed_title=?,embed_desc=?,embed_color=?,image=?,thumbnail=?,tts=?,
     username_override=?,avatar=?,delete_webhook=?,log_mode=? WHERE user_id=?`)
    .bind(v.content, clamp(v.delay, 0, 10, 0.35), clamp(v.jitter, 0, 5, 0.15),
      clamp(v.concurrency, 1, 3, 1), clamp(v.retries, 0, 8, 4),
      v.ping_everyone ? 1 : 0, v.embed ? 1 : 0, v.embed_title, v.embed_desc,
      Number(v.embed_color) || 0x5865f2, v.image, v.thumbnail, v.tts ? 1 : 0,
      v.username_override, v.avatar, v.delete_webhook ? 1 : 0,
      ["sample", "all", "errors"].includes(v.log_mode) ? v.log_mode : "sample",
      me.id).run();
  return json({ ok: true });
}

export async function listHooks(env, me) {
  const { results } = await env.DB.prepare(
    "SELECT id, label, url FROM webhooks WHERE user_id=? ORDER BY id").bind(me.id).all();
  return json(results);
}

export async function addHooks(req, env, me) {
  const { label = "", urls = "" } = await req.json().catch(() => ({}));
  const list = String(urls).split(/[\s,]+/).filter((u) => u.includes("/api/webhooks/"));
  for (const u of list) {
    await env.DB.prepare("INSERT INTO webhooks (user_id,label,url,created_at) VALUES (?,?,?,?)")
      .bind(me.id, String(label).slice(0, 40), u.trim(), Date.now()).run();
  }
  return json({ added: list.length });
}

export async function delHook(env, me, id) {
  await env.DB.prepare("DELETE FROM webhooks WHERE id=? AND user_id=?").bind(id, me.id).run();
  return json({ ok: true });
}

export async function listJobs(env, me) {
  const { results } = await env.DB.prepare(
    `SELECT id,status,total,sent,failed,created_at,started_at,finished_at
     FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 50`).bind(me.id).all();
  return json(results);
}

export async function createJob(req, env, me) {
  const b = await req.json().catch(() => ({}));
  const total = clamp(b.total, 1, 20000, 100);
  const cfg = await env.DB.prepare("SELECT * FROM settings WHERE user_id=?").bind(me.id).first();
  const merged = { ...DEFAULT_SETTINGS, ...(cfg || {}) };
  const r = await env.DB.prepare(
    "INSERT INTO jobs (user_id,status,total,cfg,created_at) VALUES (?,?,?,?,?)")
    .bind(me.id, "queued", total, JSON.stringify(merged), Date.now()).run();
  return json({ id: r.meta.last_row_id });
}

export async function getJob(url, env, me, id) {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?")
    .bind(id, me.id).first();
  if (!job) return json({ error: "not found" }, 404);
  const after = Number(url.searchParams.get("after") || 0);
  const { results } = await env.DB.prepare(
    "SELECT id,ts,level,code,msg FROM logs WHERE job_id=? AND id>? ORDER BY id LIMIT 200")
    .bind(id, after).all();
  return json({ job, logs: results });
}

export async function stopJob(env, me, id) {
  await env.DB.prepare(
    "UPDATE jobs SET status='stopping' WHERE id=? AND user_id=? AND status IN ('queued','running')")
    .bind(id, me.id).run();
  return json({ ok: true });
}