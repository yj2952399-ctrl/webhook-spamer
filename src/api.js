import { json } from "./util.js";
import { DEFAULT_SETTINGS, normalizeSettings, normalizeInput } from "./payload.js";

export async function getSettings(env, me) {
  const row = await env.DB.prepare("SELECT * FROM settings WHERE user_id = ?").bind(me.id).first();
  const merged = normalizeInput(normalizeSettings(row || {}));
  delete merged.user_id;
  return json(merged);
}

export async function putSettings(req, env, me) {
  const b = await req.json().catch(() => ({}));
  const v = normalizeInput(b);

  await env.DB.prepare(
    `INSERT INTO settings (user_id, content, delay, jitter, concurrency, retries, ping_everyone,
       embed, embed_title, embed_desc, embed_color, image, thumbnail, tts,
       username_override, avatar, delete_webhook, log_mode)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       content=excluded.content, delay=excluded.delay, jitter=excluded.jitter,
       concurrency=excluded.concurrency, retries=excluded.retries,
       ping_everyone=excluded.ping_everyone, embed=excluded.embed,
       embed_title=excluded.embed_title, embed_desc=excluded.embed_desc,
       embed_color=excluded.embed_color, image=excluded.image,
       thumbnail=excluded.thumbnail, tts=excluded.tts,
       username_override=excluded.username_override, avatar=excluded.avatar,
       delete_webhook=excluded.delete_webhook, log_mode=excluded.log_mode`)
    .bind(me.id, v.content, v.delay, v.jitter, v.concurrency, v.retries, v.ping_everyone,
      v.embed, v.embed_title, v.embed_desc, v.embed_color, v.image, v.thumbnail, v.tts,
      v.username_override, v.avatar, v.delete_webhook, v.log_mode).run();

  return json({ ok: true, settings: v });
}

export async function listHooks(env, me) {
  const { results } = await env.DB.prepare(
    "SELECT id, label, url FROM webhooks WHERE user_id=? ORDER BY id").bind(me.id).all();
  return json(results);
}

export async function addHooks(req, env, me) {
  const { label = "", urls = "" } = await req.json().catch(() => ({}));

  const list = [...new Set(String(urls)
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(u)))];

  if (!list.length) return json({ added: 0, error: "有効な Webhook URL がありません" }, 400);

  const { results: exist } = await env.DB.prepare(
    "SELECT url FROM webhooks WHERE user_id=?").bind(me.id).all();
  const known = new Set(exist.map((r) => r.url));

  let added = 0;
  for (const u of list) {
    if (known.has(u)) continue;
    await env.DB.prepare("INSERT INTO webhooks (user_id,label,url,created_at) VALUES (?,?,?,?)")
      .bind(me.id, String(label).slice(0, 40), u, Date.now()).run();
    added++;
  }
  return json({ added, skipped: list.length - added });
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
  const total = Math.round(Math.min(Math.max(Number(b.total) || 100, 1), 20000));

  const active = await env.DB.prepare(
    "SELECT id FROM jobs WHERE user_id=? AND status IN ('queued','running','stopping') LIMIT 1")
    .bind(me.id).first();
  if (active) return json({ error: `ジョブ #${active.id} がまだ動いています`, id: active.id }, 409);

  const cfgRow = await env.DB.prepare("SELECT * FROM settings WHERE user_id=?").bind(me.id).first();
  const snapshot = normalizeInput(normalizeSettings(cfgRow || {}));

  const r = await env.DB.prepare(
    "INSERT INTO jobs (user_id,status,total,cfg,created_at) VALUES (?,?,?,?,?)")
    .bind(me.id, "queued", total, JSON.stringify(snapshot), Date.now()).run();
  return json({ id: r.meta.last_row_id });
}

export async function getJob(url, env, me, id) {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=? AND user_id=?")
    .bind(id, me.id).first();
  if (!job) return json({ error: "not found" }, 404);

  const after = Number(url.searchParams.get("after") || 0) || 0;
  const { results } = await env.DB.prepare(
    "SELECT id,ts,level,code,msg FROM logs WHERE job_id=? AND id>? ORDER BY id LIMIT 200")
    .bind(id, after).all();

  return json({
    job: {
      id: job.id, status: job.status, total: job.total, sent: job.sent,
      failed: job.failed, created_at: job.created_at,
      started_at: job.started_at, finished_at: job.finished_at,
    },
    logs: results,
  });
}

export async function stopJob(env, me, id) {
  const r = await env.DB.prepare(
    "UPDATE jobs SET status='stopping' WHERE id=? AND user_id=? AND status IN ('queued','running')")
    .bind(id, me.id).run();
  return json({ ok: true, changed: r.meta.changes });
}