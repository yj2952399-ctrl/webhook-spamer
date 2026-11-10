import { json, clamp } from "./util.js";
import { DEFAULT_SETTINGS, normalizeSettings, normalizeInput } from "./payload.js";
import * as discord from "./discord.js";

const ACTIVE = ["queued", "running", "stopping"];
const DONE = new Set(["done", "stopped", "failed"]);
const mask = (t) => (t ? `${t.slice(0, 4)}…${t.slice(-4)}` : "");

/* ---- 設定 ---- */

export async function getSettings(env, me) {
  const row = await env.DB.prepare("SELECT * FROM settings WHERE user_id = ?").bind(me.id).first();
  const tune = await env.DB.prepare("SELECT batch, lanes FROM tuning WHERE user_id=?").bind(me.id).first();

  const merged = normalizeInput(normalizeSettings(row || {}));
  merged.batch = Math.round(clamp(tune?.batch, 10, 300, DEFAULT_SETTINGS.batch));
  merged.lanes = Math.round(clamp(tune?.lanes, 1, 16, DEFAULT_SETTINGS.lanes));
  delete merged.user_id;

  return json(merged);
}

export async function putSettings(req, env, me) {
  const b = await req.json().catch(() => ({}));
  const v = normalizeInput(b);

  // target_channels は実行画面で管理しているので、送られてこなければ現状維持
  if (!("target_channels" in b)) {
    const cur = await env.DB.prepare("SELECT target_channels FROM settings WHERE user_id=?")
      .bind(me.id).first();
    v.target_channels = normalizeInput({ target_channels: cur?.target_channels || "" }).target_channels;
  }

  await env.DB.prepare(
    `INSERT INTO settings (user_id, content, delay, jitter, concurrency, retries, ping_everyone,
       embed, embed_title, embed_desc, embed_color, image, thumbnail, tts,
       username_override, avatar, delete_webhook, log_mode, target_channels)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       content=excluded.content, delay=excluded.delay, jitter=excluded.jitter,
       concurrency=excluded.concurrency, retries=excluded.retries,
       ping_everyone=excluded.ping_everyone, embed=excluded.embed,
       embed_title=excluded.embed_title, embed_desc=excluded.embed_desc,
       embed_color=excluded.embed_color, image=excluded.image,
       thumbnail=excluded.thumbnail, tts=excluded.tts,
       username_override=excluded.username_override, avatar=excluded.avatar,
       delete_webhook=excluded.delete_webhook, log_mode=excluded.log_mode,
       target_channels=excluded.target_channels`)
    .bind(me.id, v.content, v.delay, v.jitter, v.concurrency, v.retries, v.ping_everyone,
      v.embed, v.embed_title, v.embed_desc, v.embed_color, v.image, v.thumbnail, v.tts,
      v.username_override, v.avatar, v.delete_webhook, v.log_mode,
      v.target_channels.join(",")).run();

  await env.DB.prepare(
    `INSERT INTO tuning (user_id, batch, lanes) VALUES (?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET batch=excluded.batch, lanes=excluded.lanes`)
    .bind(me.id, v.batch, v.lanes).run();

  return json({ ok: true, settings: v });
}

/* ---- Webhook ---- */

export async function listHooks(env, me) {
  const { results } = await env.DB.prepare(
    "SELECT id, label, url, channel_id, channel_name FROM webhooks WHERE user_id=? ORDER BY id")
    .bind(me.id).all();
  return json(results);
}

async function insertHooks(env, me, rows) {
  const { results: exist } = await env.DB.prepare(
    "SELECT id, url FROM webhooks WHERE user_id=?").bind(me.id).all();
  const known = new Map(exist.map((r) => [r.url, r.id]));

  let added = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const url = String(r.url || "").trim();
    if (!url) { skipped++; continue; }

    const label = String(r.label || "").slice(0, 40);
    const cid = String(r.channel_id || "");
    const cname = String(r.channel_name || "").slice(0, 80);

    const id = known.get(url);
    if (id) {
      // 同じ URL が既にある → チャンネル紐付けだけ更新
      await env.DB.prepare(
        "UPDATE webhooks SET label=?, channel_id=?, channel_name=? WHERE id=? AND user_id=?")
        .bind(label, cid, cname, id, me.id).run();
      updated++;
      continue;
    }

    await env.DB.prepare(
      "INSERT INTO webhooks (user_id,label,url,channel_id,channel_name,created_at) VALUES (?,?,?,?,?,?)")
      .bind(me.id, label, url, cid, cname, Date.now()).run();
    known.set(url, -1);
    added++;
  }
  return { added, updated, skipped };
}

export async function addHooks(req, env, me) {
  const { label = "", urls = "", channel_id = "" } = await req.json().catch(() => ({}));
  const ch = String(channel_id).trim();

  const list = [...new Set(String(urls)
    .split(/[\s,]+/)
    .map((u) => u.trim())
    .filter((u) => /^https?:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\//.test(u)))];

  if (!list.length) return json({ ok: false, error: "有効な Webhook URL がありません" }, 400);

  const { added, updated } = await insertHooks(env, me, list.map((url) => ({
    label, url, channel_id: /^\d{5,25}$/.test(ch) ? ch : "", channel_name: "",
  })));

  return json({ ok: true, added, updated, skipped: list.length - added - updated });
}

export async function delHook(env, me, id) {
  await env.DB.prepare("DELETE FROM webhooks WHERE id=? AND user_id=?").bind(id, me.id).run();
  return json({ ok: true });
}

export async function clearHooks(env, me, channel = "") {
  const ch = String(channel || "").trim();
  const r = ch
    ? await env.DB.prepare("DELETE FROM webhooks WHERE user_id=? AND channel_id=?")
      .bind(me.id, ch).run()
    : await env.DB.prepare("DELETE FROM webhooks WHERE user_id=?").bind(me.id).run();
  return json({ ok: true, deleted: r.meta.changes });
}

/** 登録済み Webhook をチャンネル単位で集計 */
export async function listChannels(env, me) {
  const { results } = await env.DB.prepare(
    `SELECT channel_id, MAX(channel_name) AS channel_name, COUNT(*) AS hooks
     FROM webhooks WHERE user_id=? AND channel_id<>'' GROUP BY channel_id ORDER BY channel_id`)
    .bind(me.id).all();
  return json(results);
}

/* ---- トークン ---- */

export async function getDiscord(env, me) {
  const row = await env.DB.prepare("SELECT token, guild_id FROM discord WHERE user_id=?")
    .bind(me.id).first();
  return json({
    ok: true,
    token_set: !!row?.token,
    token_hint: mask(row?.token),
    guild_id: row?.guild_id || "",
  });
}

export async function putDiscord(req, env, me) {
  const { token = "", guild_id = "" } = await req.json().catch(() => ({}));
  const t = String(token).trim().replace(/^Bot\s+/i, "");
  const g = String(guild_id).trim();

  if (t && !/^[\w.-]{40,}$/.test(t)) return json({ ok: false, error: "トークンの形式が不正です" }, 400);
  if (g && !/^\d{15,25}$/.test(g)) return json({ ok: false, error: "サーバーIDが不正です" }, 400);

  await env.DB.prepare(
    `INSERT INTO discord (user_id, token, guild_id, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       token = CASE WHEN excluded.token <> '' THEN excluded.token ELSE discord.token END,
       guild_id = CASE WHEN excluded.guild_id <> '' THEN excluded.guild_id ELSE discord.guild_id END,
       updated_at = excluded.updated_at`).bind(me.id, t, g, Date.now()).run();

  return json({ ok: true });
}

export async function checkDiscord(env, me) {
  const row = await env.DB.prepare("SELECT token, guild_id FROM discord WHERE user_id=?")
    .bind(me.id).first();
  if (!row?.token || !row?.guild_id) {
    return json({ ok: false, error: "トークンとサーバーIDを保存してください" }, 400);
  }

  try {
    const info = await discord.inspect(row.token, row.guild_id);
    return json({ ok: true, user: info.user, guild: info.guild, channels: info.channels });
  } catch (e) {
    return json({ ok: false, error: e.message }, 400);
  }
}

export async function autoHooks(req, env, me) {
  const b = await req.json().catch(() => ({}));
  const dflt = Math.round(Math.min(Math.max(Number(b.count) || 10, 1), discord.PER_CHANNEL_MAX));

  const row = await env.DB.prepare("SELECT token, guild_id FROM discord WHERE user_id=?")
    .bind(me.id).first();
  if (!row?.token || !row?.guild_id) {
    return json({ ok: false, error: "トークンとサーバーIDを保存してください" }, 400);
  }

  let info;
  try { info = await discord.inspect(row.token, row.guild_id); }
  catch (e) { return json({ ok: false, error: e.message }, 400); }

  const allowed = new Set(info.channels.filter((c) => c.can).map((c) => c.id));

  // { channels:[{id,count}] } も { channels:["id"], count } も受ける
  const quota = new Map();
  for (const item of Array.isArray(b.channels) ? b.channels : []) {
    const obj = item && typeof item === "object";
    const id = String(obj ? item.id : item);
    if (!allowed.has(id)) continue;
    const n = obj
      ? Math.round(Math.min(Math.max(Number(item.count) || 0, 0), discord.PER_CHANNEL_MAX))
      : dflt;
    if (n > 0) quota.set(id, n);
  }

  if (!quota.size) {
    if (!allowed.size) return json({ ok: false, error: "Webhook を作れるチャンネルがありません" }, 400);
    for (const id of allowed) quota.set(id, dflt);
  }

  const chans = info.channels.filter((c) => quota.has(c.id));
  const limit = Math.min([...quota.values()].reduce((a, n) => a + n, 0), 200);

  try {
    const { created, errors } = await discord.createWebhooks(info.auth, chans, quota, limit);
    const { added, updated, skipped } = await insertHooks(env, me, created.map((c) => ({
      label: c.name, url: c.url, channel_id: c.channelId, channel_name: c.name,
    })));

    if (created.length && added + updated === 0) {
      errors.unshift(`作成は ${created.length} 件成功しましたが登録できませんでした`);
    }

    return json({
      ok: true,
      created: created.length,
      added,
      updated,
      skipped,
      requested: limit,
      channels: chans.length,
      errors: errors.slice(0, 10),
    });
  } catch (e) {
    return json({ ok: false, error: `発行処理でエラー: ${e?.message || String(e)}` }, 500);
  }
}

/* ---- ジョブ ---- */

export async function listJobs(env, me) {
  const { results } = await env.DB.prepare(
    `SELECT id,status,total,sent,failed,created_at,started_at,finished_at
     FROM jobs WHERE user_id=? ORDER BY id DESC LIMIT 50`).bind(me.id).all();
  return json(results);
}

async function forceStopRow(env, me, id) {
  const nowMs = Date.now();
  await env.DB.prepare(
    `UPDATE jobs SET status='stopped', finished_at=?
     WHERE id=? AND user_id=? AND status NOT IN ('done','stopped','failed')`)
    .bind(nowMs, id, me.id).run();
  await env.DB.prepare("DELETE FROM locks WHERE job_id=?").bind(id).run();
}

export async function createJob(req, env, me) {
  const b = await req.json().catch(() => ({}));
  const total = Math.round(Math.min(Math.max(Number(b.total) || 100, 1), 20000));

  const active = await env.DB.prepare(
    "SELECT id, status FROM jobs WHERE user_id=? AND status IN ('queued','running','stopping') ORDER BY id LIMIT 1")
    .bind(me.id).first();

  if (active) {
    const lock = await env.DB.prepare("SELECT at FROM locks WHERE job_id=?").bind(active.id).first();
    const live = !!lock && lock.at > Date.now() - 45000;
    if (live) return json({ ok: false, error: `ジョブ #${active.id} がまだ動いています`, id: active.id }, 409);
    await forceStopRow(env, me, active.id);
  }

  const cfgRow = await env.DB.prepare("SELECT * FROM settings WHERE user_id=?").bind(me.id).first();
  const tune = await env.DB.prepare("SELECT batch, lanes FROM tuning WHERE user_id=?").bind(me.id).first();

  const snapshot = normalizeInput(normalizeSettings(cfgRow || {}));
  if (tune) {
    snapshot.batch = Math.round(clamp(tune.batch, 10, 300, DEFAULT_SETTINGS.batch));
    snapshot.lanes = Math.round(clamp(tune.lanes, 1, 16, DEFAULT_SETTINGS.lanes));
  }

  // 指定があればそのチャンネルだけを対象にする（設定にも残す）
  if (Array.isArray(b.channels)) {
    snapshot.target_channels = [...new Set(b.channels.map(String))]
      .filter((id) => /^\d{5,25}$/.test(id)).slice(0, 200);
    await env.DB.prepare("UPDATE settings SET target_channels=? WHERE user_id=?")
      .bind(snapshot.target_channels.join(","), me.id).run();
  }

  const r = await env.DB.prepare(
    "INSERT INTO jobs (user_id,status,total,cfg,created_at) VALUES (?,?,?,?,?)")
    .bind(me.id, "queued", total, JSON.stringify(snapshot), Date.now()).run();

  return json({ ok: true, id: r.meta.last_row_id });
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

export async function stopJob(env, me, id, force) {
  const job = await env.DB.prepare("SELECT id, status FROM jobs WHERE id=? AND user_id=?")
    .bind(id, me.id).first();
  if (!job) return json({ ok: false, error: "not found" }, 404);

  if (force) {
    await forceStopRow(env, me, id);
    await env.DB.prepare(
      "INSERT INTO logs (job_id, user_id, ts, level, code, msg) VALUES (?,?,?,?,?,?)")
      .bind(id, me.id, Date.now(), "error", 0, "強制停止").run();
    return json({ ok: true, status: "stopped", was: job.status });
  }

  if (DONE.has(job.status)) return json({ ok: true, status: job.status, already: true });

  await env.DB.prepare(
    "UPDATE jobs SET status='stopping' WHERE id=? AND user_id=? AND status IN ('queued','running')")
    .bind(id, me.id).run();

  return json({ ok: true, status: "stopping", was: job.status });
}

export async function stopAllJobs(env, me) {
  const nowMs = Date.now();
  const r = await env.DB.prepare(
    `UPDATE jobs SET status='stopped', finished_at=?
     WHERE user_id=? AND status NOT IN ('done','stopped','failed')`).bind(nowMs, me.id).run();

  await env.DB.prepare(
    "DELETE FROM locks WHERE job_id IN (SELECT id FROM jobs WHERE user_id=?)").bind(me.id).run();

  return json({ ok: true, changed: r.meta.changes });
}

export async function deleteJob(env, me, id) {
  await env.DB.prepare("DELETE FROM logs WHERE job_id=? AND user_id=?").bind(id, me.id).run();
  await env.DB.prepare("DELETE FROM locks WHERE job_id=?").bind(id).run();
  const r = await env.DB.prepare("DELETE FROM jobs WHERE id=? AND user_id=?").bind(id, me.id).run();
  return json({ ok: true, deleted: r.meta.changes });
}