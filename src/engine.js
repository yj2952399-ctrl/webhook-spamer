import { sleep, now, clamp } from "./util.js";
import { build, DEFAULT_SETTINGS, normalizeSettings } from "./payload.js";

const WALL_BUDGET = 40000; // 実行を打ち切るまでのミリ秒
const BATCH_MAX = 40;      // 1 回の起動で送る上限（CPU 10ms 対策）
const LOCK_MS = 45000;     // 二重起動よけ。WALL_BUDGET より長くする
const DONE = new Set(["done", "stopped", "failed"]);

/** ロック取得。既に他が持っていて期限内なら false */
async function acquire(env, jobId) {
  const t = now();
  const r = await env.DB.prepare(
    `INSERT INTO locks (job_id, at) VALUES (?, ?)
     ON CONFLICT(job_id) DO UPDATE SET at = excluded.at
     WHERE locks.at < ?`).bind(jobId, t, t - LOCK_MS).run();
  return (r.meta.changes || 0) > 0;
}

const release = (env, jobId) =>
  env.DB.prepare("DELETE FROM locks WHERE job_id=?").bind(jobId).run();

async function writeLog(env, job, level, code, msg, cfg) {
  const keep = level === "error" || cfg.log_mode === "all"
    || (cfg.log_mode === "sample" && Math.random() < 0.1);
  if (!keep) return;
  try {
    await env.DB.prepare(
      "INSERT INTO logs (job_id, user_id, ts, level, code, msg) VALUES (?,?,?,?,?,?)")
      .bind(job.id, job.user_id, Date.now(), level, code, String(msg ?? "").slice(0, 300)).run();
  } catch {}
}

/** 中断可能な待機。st.stop が立ったら即座に返る */
async function nap(st, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (st.stop) return;
    await sleep(Math.min(250, end - Date.now()));
  }
}

async function sendOne(env, job, cfg, hook, n, st) {
  if (st.stop) return;
  const body = JSON.stringify(build(cfg, n));
  const tag = hook.label || String(hook.url).slice(-8);

  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    if (st.stop) return;

    const ctrl = new AbortController();
    st.ctrls.add(ctrl);
    let res;
    try {
      res = await fetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (ctrl.signal.aborted) { st.ctrls.delete(ctrl); return; }
      st.ctrls.delete(ctrl);
      if (attempt >= cfg.retries) break;
      await nap(st, 600 * (attempt + 1));
      continue;
    }
    st.ctrls.delete(ctrl);

    if (res.status === 200 || res.status === 204) {
      st.sent++;
      await writeLog(env, job, "ok", res.status, `${tag} #${n}`, cfg);
      return;
    }

    if (res.status === 429) {
      let w = 1;
      try { w = Number((await res.json()).retry_after) || 1; }
      catch { w = Number(res.headers.get("retry-after")) || 1; }
      await nap(st, Math.min(w, 8) * 1000);
      continue;
    }

    if (res.status === 404) {
      st.failed++;
      await writeLog(env, job, "error", 404, `Webhook 消失: ${tag}`, cfg);
      return;
    }

    if (res.status >= 500) {
      if (attempt >= cfg.retries) break;
      await nap(st, 800 * (attempt + 1));
      continue;
    }

    let detail = "";
    try { detail = (await res.text()).slice(0, 200); } catch {}
    st.failed++;
    await writeLog(env, job, "error", res.status, `${tag} #${n} ${detail}`, cfg);
    return;
  }

  if (st.stop) return;
  st.failed++;
  await writeLog(env, job, "error", 0, `再試行上限: ${tag}`, cfg);
}

export async function runJob(env, job) {
  const started = now();

  if (!(await acquire(env, job.id))) return;

  const fresh = await env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(job.id).first();
  if (!fresh || DONE.has(fresh.status)) { await release(env, job.id); return; }

  let cfg;
  try {
    cfg = normalizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(fresh.cfg || "{}") });
  } catch {
    cfg = { ...DEFAULT_SETTINGS };
  }
  cfg.retries = Math.round(clamp(cfg.retries, 0, 8, DEFAULT_SETTINGS.retries));
  cfg.delay = clamp(cfg.delay, 0, 10, DEFAULT_SETTINGS.delay);
  cfg.jitter = clamp(cfg.jitter, 0, 5, DEFAULT_SETTINGS.jitter);

  // ctrls: 飛んでいる fetch を強制停止時に切るための入れ物
  const st = { sent: fresh.sent || 0, failed: fresh.failed || 0, claimed: 0, stop: false, hard: false, ctrls: new Set() };
  st.claimed = st.sent + st.failed;

  const finish = async (status) => {
    if (st.hard) {
      // 既に stopped になっている。件数だけ反映する
      await env.DB.prepare("UPDATE jobs SET sent=?, failed=? WHERE id=?")
        .bind(st.sent, st.failed, fresh.id).run();
    } else {
      await env.DB.prepare(
        "UPDATE jobs SET status=?, sent=?, failed=?, finished_at=? WHERE id=?")
        .bind(status, st.sent, st.failed, DONE.has(status) ? Date.now() : null, fresh.id).run();
    }
    await release(env, fresh.id);
  };

  const { results: hooks } = await env.DB.prepare(
    "SELECT id, label, url FROM webhooks WHERE user_id = ? ORDER BY id").bind(fresh.user_id).all();

  if (!hooks.length) {
    await writeLog(env, fresh, "error", 0, "Webhook 未登録", cfg);
    await finish("failed");
    return;
  }

  if (st.claimed >= fresh.total) { await finish("done"); return; }
  if (fresh.status === "stopping" || fresh.status === "stopped") { await finish("stopped"); return; }

  await env.DB.prepare(
    "UPDATE jobs SET status='running', started_at=COALESCE(started_at,?) WHERE id=?")
    .bind(started, fresh.id).run();

  const deadline = started + WALL_BUDGET;
  const batchEnd = st.claimed + BATCH_MAX;
  let lastCheck = 0;

  const checkStop = async () => {
    if (Date.now() - lastCheck < 600) return st.stop;
    lastCheck = Date.now();
    const r = await env.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(fresh.id).first();
    if (r?.status === "stopping") st.stop = true;
    if (r?.status === "stopped" || DONE.has(r?.status)) {
      st.stop = true;
      st.hard = true;
      for (const c of st.ctrls) c.abort();
    }
    return st.stop;
  };

  const lanes = Math.max(1, Math.min(Math.round(Number(cfg.concurrency) || 1), 3));

  await Promise.all(Array.from({ length: lanes }, async (_, k) => {
    let i = k;
    while (true) {
      if (st.claimed >= fresh.total || st.claimed >= batchEnd) break;
      if (Date.now() > deadline) break;
      if (await checkStop()) break;
      const hook = hooks[i++ % hooks.length];
      st.claimed++;
      await sendOne(env, fresh, cfg, hook, st.claimed, st);
      await nap(st, cfg.delay * 1000 + Math.random() * cfg.jitter * 1000);
    }
  }));

  const done = st.sent + st.failed >= fresh.total;
  await finish(done ? "done" : st.stop ? "stopped" : "running");

  if (done || st.stop) {
    await writeLog(env, fresh, "ok", 0,
      `${st.hard ? "強制停止" : "終了"} 成功 ${st.sent} / 失敗 ${st.failed}`, cfg);
  }

  if (done && cfg.delete_webhook) {
    for (const h of hooks) {
      try { await fetch(h.url, { method: "DELETE" }); } catch {}
    }
  }
}

export async function tick(env) {
  const stale = Date.now() - LOCK_MS;
  try { await env.DB.prepare("DELETE FROM locks WHERE at < ?").bind(stale).run(); } catch {}

  const { results } = await env.DB.prepare(
    `SELECT j.* FROM jobs j
     LEFT JOIN locks l ON l.job_id = j.id
     WHERE j.status IN ('queued','running') AND (l.at IS NULL OR l.at < ?)
     ORDER BY j.id LIMIT 3`).bind(stale).all();

  await Promise.all(results.map((j) => runJob(env, j).catch(() => {})));
}