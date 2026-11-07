import { sleep } from "./util.js";
import { build, DEFAULT_SETTINGS } from "./payload.js";

const WALL_BUDGET = 40000; // 実行を打ち切るまでのミリ秒
const BATCH_MAX = 40;      // 1 回の起動で送る上限（CPU 10ms 対策）

async function writeLog(env, job, level, code, msg, cfg) {
  const keep = level === "error" || cfg.log_mode === "all"
    || (cfg.log_mode === "sample" && Math.random() < 0.1);
  if (!keep) return;
  await env.DB.prepare(
    "INSERT INTO logs (job_id, user_id, ts, level, code, msg) VALUES (?,?,?,?,?,?)")
    .bind(job.id, job.user_id, Date.now(), level, code, String(msg).slice(0, 300)).run();
}

async function sendOne(env, job, cfg, hook, n, st) {
  const body = JSON.stringify(build(cfg, n));
  const tag = hook.label || hook.url.slice(-8);

  for (let attempt = 0; attempt <= cfg.retries; attempt++) {
    let res;
    try {
      res = await fetch(hook.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch (e) {
      if (attempt >= cfg.retries) break;
      await sleep(600 * (attempt + 1));
      continue;
    }
    if (res.status === 200 || res.status === 204) {
      st.sent++;
      await writeLog(env, job, "ok", res.status, `${tag} #${n}`, cfg);
      return;
    }
    if (res.status === 429) {
      let w = 1;
      try { w = (await res.json()).retry_after ?? 1; }
      catch { w = Number(res.headers.get("retry-after") || 1); }
      await sleep(Math.min(w, 8) * 1000);
      continue;
    }
    if (res.status === 404) {
      st.failed++;
      await writeLog(env, job, "error", 404, `Webhook 消失: ${tag}`, cfg);
      return;
    }
    if (res.status >= 500) {
      if (attempt >= cfg.retries) break;
      await sleep(800 * (attempt + 1));
      continue;
    }
    st.failed++;
    await writeLog(env, job, "error", res.status, (await res.text()).slice(0, 200), cfg);
    return;
  }
  st.failed++;
  await writeLog(env, job, "error", 0, `再試行上限: ${tag}`, cfg);
}

export async function runJob(env, job) {
  const cfg = { ...DEFAULT_SETTINGS, ...JSON.parse(job.cfg || "{}") };
  const { results: hooks } = await env.DB.prepare(
    "SELECT id, label, url FROM webhooks WHERE user_id = ?").bind(job.user_id).all();

  if (!hooks.length) {
    await env.DB.prepare("UPDATE jobs SET status='failed', finished_at=? WHERE id=?")
      .bind(Date.now(), job.id).run();
    await writeLog(env, job, "error", 0, "Webhook 未登録", cfg);
    return;
  }

  await env.DB.prepare(
    "UPDATE jobs SET status='running', started_at=COALESCE(started_at,?) WHERE id=?")
    .bind(Date.now(), job.id).run();

  const st = { sent: job.sent, failed: job.failed, claimed: job.sent + job.failed, stop: false };
  const deadline = Date.now() + WALL_BUDGET;
  const batchEnd = st.claimed + BATCH_MAX;
  let lastCheck = 0;

  const checkStop = async () => {
    if (Date.now() - lastCheck < 1500) return st.stop;
    lastCheck = Date.now();
    const r = await env.DB.prepare("SELECT status FROM jobs WHERE id=?").bind(job.id).first();
    if (r?.status === "stopping") st.stop = true;
    return st.stop;
  };

  const flush = () => env.DB.prepare("UPDATE jobs SET sent=?, failed=? WHERE id=?")
    .bind(st.sent, st.failed, job.id).run();

  const lanes = Math.max(1, Math.min(Number(cfg.concurrency) || 1, 3));
  await Promise.all(Array.from({ length: lanes }, async (_, k) => {
    let i = k;
    while (true) {
      if (st.claimed >= job.total || st.claimed >= batchEnd) break;
      if (Date.now() > deadline) break;
      if (await checkStop()) break;
      const hook = hooks[i++ % hooks.length];
      st.claimed++;
      await sendOne(env, job, cfg, hook, st.claimed, st);
      await sleep(Number(cfg.delay) * 1000 + Math.random() * Number(cfg.jitter) * 1000);
    }
  }));

  await flush();
  const done = st.sent + st.failed >= job.total;
  await env.DB.prepare("UPDATE jobs SET status=?, finished_at=? WHERE id=?")
    .bind(done ? "done" : st.stop ? "stopped" : "running",
          done || st.stop ? Date.now() : null, job.id).run();

  if (done || st.stop) {
    await writeLog(env, job, "ok", 0, `終了 成功 ${st.sent} / 失敗 ${st.failed}`, cfg);
  }
  if (done && cfg.delete_webhook) {
    for (const h of hooks) {
      try { await fetch(h.url, { method: "DELETE" }); } catch {}
    }
  }
}

export async function tick(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM jobs WHERE status IN ('queued','running') ORDER BY id LIMIT 3").all();
  await Promise.all(results.map((j) => runJob(env, j).catch(() => {})));
}