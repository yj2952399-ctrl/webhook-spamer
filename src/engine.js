import { sleep, now, clamp } from "./util.js";
import { build, DEFAULT_SETTINGS, normalizeSettings } from "./payload.js";

const WALL_BUDGET = 40000;
const LOCK_MS = 45000;
const DONE = new Set(["done", "stopped", "failed"]);
const DEAD = new Set([401, 403, 404]);

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

async function nap(st, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (st.stop) return;
    await sleep(Math.min(200, end - Date.now()));
  }
}

/** 使える中で最も早く送れる Webhook を選ぶ。全滅なら null */
function pick(state, at) {
  let best = null;
  for (const s of state) {
    if (s.dead || s.busy) continue;
    if (s.nextAt <= at) return s;
    if (!best || s.nextAt < best.nextAt) best = s;
  }
  return best;
}

async function deliver(env, cfg, state, slot, n, st, log) {
  const body = JSON.stringify(build(cfg, n));
  const max = Math.min(cfg.retries + 4, 12);
  let tries = 0;

  while (true) {
    if (st.stop) return;
    tries++;

    const tag = slot.h.label || String(slot.h.url).slice(-8);
    const ctrl = new AbortController();
    st.ctrls.add(ctrl);

    let res = null, err = false;
    try {
      res = await fetch(slot.h.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: ctrl.signal,
      });
    } catch { err = true; }
    st.ctrls.delete(ctrl);
    if (ctrl.signal.aborted) { slot.busy = false; return; }

    const t = Date.now();
    slot.busy = false;

    if (!err && (res.status === 200 || res.status === 204)) {
      st.sent++;
      slot.nextAt = t + cfg.delay * 1000 + Math.random() * cfg.jitter * 1000;
      log("ok", res.status, `${tag} #${n}`);
      return;
    }

    if (!err && res.status === 429) {
      let w = 1;
      try { w = Number((await res.json()).retry_after) || 1; }
      catch { w = Number(res.headers.get("retry-after")) || 1; }
      slot.nextAt = t + Math.min(w, 8) * 1000;
    } else if (!err && DEAD.has(res.status)) {
      slot.dead = true;
      slot.nextAt = Infinity;
      log("error", res.status, `Webhook 無効: ${tag}`);
    } else {
      slot.nextAt = t + 400;
      let d = "";
      if (!err) { try { d = (await res.text()).slice(0, 150); } catch {} }
      log("error", err ? 0 : res.status, `${tag} #${n} ${d}`);
    }

    if (tries >= max) { st.failed++; log("error", 0, `断念: ${tag} #${n}`); return; }

    // 待たずに別の Webhook へ切り替える
    const alt = pick(state, Date.now());
    if (!alt) { st.failed++; log("error", 0, `全 Webhook 冷却中: #${n}`); return; }

    const wait = alt.nextAt - Date.now();
    if (wait > 0) await nap(st, Math.min(wait, 5000));
    alt.busy = true;
    slot = alt;
  }
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
  cfg.lanes = Math.round(clamp(cfg.lanes, 1, 16, DEFAULT_SETTINGS.lanes));
  cfg.batch = Math.round(clamp(cfg.batch, 10, 300, DEFAULT_SETTINGS.batch));

  const st = { sent: fresh.sent || 0, failed: fresh.failed || 0, claimed: 0, stop: false, hard: false, ctrls: new Set() };
  st.claimed = st.sent + st.failed;

  // ログはまとめて 1 回の INSERT にする（サブリクエスト削減）
  const pending = [];
  const log = (level, code, msg) => {
    const keep = level === "error" || cfg.log_mode === "all"
      || (cfg.log_mode === "sample" && Math.random() < 0.1);
    if (!keep || pending.length >= 96) return;
    pending.push([fresh.id, fresh.user_id, Date.now(), level, code, String(msg ?? "").slice(0, 300)]);
  };
  const flushLogs = async () => {
    if (!pending.length) return;
    const rows = pending.splice(0, 16);
    const ph = rows.map(() => "(?,?,?,?,?,?)").join(",");
    try {
      await env.DB.prepare(`INSERT INTO logs (job_id,user_id,ts,level,code,msg) VALUES ${ph}`)
        .bind(...rows.flat()).run();
    } catch {}
  };
  const flushCount = () => env.DB.prepare("UPDATE jobs SET sent=?, failed=? WHERE id=?")
    .bind(st.sent, st.failed, fresh.id).run();

  const finish = async (status) => {
    await flushLogs();
    if (st.hard) {
      await env.DB.prepare("UPDATE jobs SET sent=?, failed=? WHERE id=?")
        .bind(st.sent, st.failed, fresh.id).run();
    } else {
      await env.DB.prepare(
        "UPDATE jobs SET status=?, sent=?, failed=?, finished_at=? WHERE id=?")
        .bind(status, st.sent, st.failed, DONE.has(status) ? Date.now() : null, fresh.id).run();
    }
    await release(env, fresh.id);
  };

  if (fresh.status === "stopping") {
    await finish("stopped");
    log("ok", 0, `終了 成功 ${st.sent} / 失敗 ${st.failed}`);
    await flushLogs();
    return;
  }

  const { results: hooks } = await env.DB.prepare(
    "SELECT id, label, url FROM webhooks WHERE user_id = ? ORDER BY id").bind(fresh.user_id).all();

  if (!hooks.length) {
    log("error", 0, "Webhook 未登録");
    await finish("failed");
    return;
  }

  if (st.claimed >= fresh.total) { await finish("done"); return; }

  await env.DB.prepare(
    "UPDATE jobs SET status='running', started_at=COALESCE(started_at,?) WHERE id=?")
    .bind(started, fresh.id).run();

  const state = hooks.map((h) => ({ h, busy: false, nextAt: 0, dead: false }));
  const before = st.claimed;
  const deadline = started + WALL_BUDGET;
  const batchEnd = st.claimed + cfg.batch;
  const lanes = Math.max(1, Math.min(cfg.lanes, hooks.length, 16));
  let lastCheck = 0, sinceFlush = 0;

  const checkStop = async () => {
    if (Date.now() - lastCheck < 400) return st.stop;
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

  await Promise.all(Array.from({ length: lanes }, async () => {
    while (true) {
      if (st.claimed >= fresh.total || st.claimed >= batchEnd) break;
      if (Date.now() > deadline) break;
      if (await checkStop()) break;

      const slot = pick(state, Date.now());
      if (!slot) break;
      slot.busy = true;

      const wait = slot.nextAt - Date.now();
      if (wait > 0) {
        if (Date.now() + wait > deadline) { slot.busy = false; break; }
        await nap(st, wait);
        if (st.stop) { slot.busy = false; break; }
      }

      st.claimed++;
      await deliver(env, cfg, state, slot, st.claimed, st, log);

      if (++sinceFlush >= 20) { sinceFlush = 0; await flushCount(); await flushLogs(); }
    }
  }));

  const done = st.sent + st.failed >= fresh.total;
  const progressed = st.sent + st.failed > before;

  await finish(done ? "done" : st.stop ? "stopped" : progressed ? "running" : "failed");

  if (done || st.stop) {
    log("ok", 0, `${st.hard ? "強制停止" : "終了"} 成功 ${st.sent} / 失敗 ${st.failed}`);
  } else if (!progressed) {
    log("error", 0, "進捗なしのため中断");
  }

  // 死んだ Webhook は掃除
  const deadIds = state.filter((s) => s.dead).map((s) => s.h.id);
  for (const id of deadIds) {
    try { await env.DB.prepare("DELETE FROM webhooks WHERE id=? AND user_id=?").bind(id, fresh.user_id).run(); } catch {}
  }

  await flushLogs();

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
     WHERE j.status IN ('queued','running','stopping') AND (l.at IS NULL OR l.at < ?)
     ORDER BY j.id LIMIT 3`).bind(stale).all();

  await Promise.all(results.map((j) => runJob(env, j).catch(() => {})));
}