const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const ACTIVE = ["queued", "running", "stopping"];

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (r.status === 401) {
    $("app").hidden = true; $("auth").hidden = false;
    throw new Error("401");
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) data.__status = r.status;
  return data;
}

const creds = () => ({ username: $("u").value.trim(), password: $("p").value });

const register = async () => {
  const r = await api("/api/register", { method: "POST", body: JSON.stringify(creds()) });
  r.ok ? boot() : alert(r.error || "登録失敗");
};

const login = async () => {
  const r = await api("/api/login", { method: "POST", body: JSON.stringify(creds()) });
  r.ok ? boot() : alert(r.error || "ログイン失敗");
};

const logout = async () => {
  await api("/api/logout", { method: "POST" });
  location.reload();
};

document.querySelectorAll("nav button").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tab").forEach((t) => t.hidden = true);
  $("tab-" + b.dataset.tab).hidden = false;
});

async function boot() {
  let me;
  try { me = await api("/api/me"); } catch { return; }
  $("who").textContent = me.username;
  $("auth").hidden = true; $("app").hidden = false;
  $("logout").hidden = false;

  const s = await api("/api/settings");
  for (const [k, v] of Object.entries(s)) {
    const el = $("s-" + k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v;
    else el.value = v ?? "";
  }
  loadHooks(); loadJobs();
}

async function saveSettings() {
  const b = {};
  document.querySelectorAll("[id^=s-]").forEach((el) => {
    const k = el.id.slice(2);
    if (el.type === "checkbox") b[k] = el.checked ? 1 : 0;
    else if (el.type === "number") { if (el.value !== "") b[k] = Number(el.value); }
    else b[k] = el.value;
  });

  const r = await api("/api/settings", { method: "PUT", body: JSON.stringify(b) });
  if (!r.ok) return alert(r.error || "保存失敗");

  if (r.settings) {
    for (const [k, v] of Object.entries(r.settings)) {
      const el = $("s-" + k);
      if (!el) continue;
      if (el.type === "checkbox") el.checked = !!v;
      else el.value = v ?? "";
    }
  }
  alert("保存しました");
}

async function addHooks() {
  const r = await api("/api/webhooks", {
    method: "POST",
    body: JSON.stringify({ label: $("hlabel").value, urls: $("hurls").value }),
  });
  if (!r.ok) return alert(r.error || "追加できませんでした");
  $("hurls").value = "";
  loadHooks();
}

async function loadHooks() {
  const list = await api("/api/webhooks");
  $("hlist").innerHTML = list.length
    ? list.map((h) =>
      `<li><b>${esc(h.label || "-")}</b> <code>…${esc(h.url.slice(-10))}</code>
       <button onclick="delHook(${h.id})">削除</button></li>`).join("")
    : `<li class="note">まだ登録がありません</li>`;
}

const delHook = async (id) => { await api("/api/webhooks/" + id, { method: "DELETE" }); loadHooks(); };

async function startJob() {
  const total = Number($("total").value);
  if (!Number.isFinite(total) || total < 1) return alert("投稿数を入れてください");

  const r = await api("/api/jobs", { method: "POST", body: JSON.stringify({ total }) });
  if (!r.ok) return alert(r.error || "開始できませんでした");
  alert("ジョブ #" + r.id + " を登録しました。最大 60 秒で動き出します。");
  loadJobs();
}

async function loadJobs() {
  const jobs = await api("/api/jobs");
  const active = jobs.filter((j) => ACTIVE.includes(j.status));

  $("active").innerHTML = active.length
    ? active.map((j) =>
      `<div class="card">実行中: #${j.id} <b>${esc(j.status)}</b> ${j.sent}/${j.total}
        <button onclick="stopJob(${j.id})">停止</button>
        <button class="danger" onclick="forceStop(${j.id})">強制停止</button></div>`).join("")
    : `<div class="note">稼働中のジョブはありません</div>`;

  $("stopAll").hidden = !active.length;

  $("jlist").innerHTML = jobs.length
    ? jobs.map((j) =>
      `<li>#${j.id} <b>${esc(j.status)}</b> ${j.sent}/${j.total}（失敗 ${j.failed}）
       <button onclick="openJob(${j.id})">詳細</button>
       ${ACTIVE.includes(j.status)
        ? `<button onclick="stopJob(${j.id})">停止</button>
           <button class="danger" onclick="forceStop(${j.id})">強制停止</button>`
        : ""}</li>`).join("")
    : `<li class="note">履歴はありません</li>`;
}

const stopJob = async (id) => {
  const r = await api(`/api/jobs/${id}/stop`, { method: "POST" });
  if (!r.changed) alert("すでに止まっています");
  loadJobs();
};

const forceStop = async (id) => {
  if (!confirm(`ジョブ #${id} を強制停止します。送信中の分は打ち切られます。`)) return;
  await api(`/api/jobs/${id}/stop?force=1`, { method: "POST" });
  loadJobs();
};

const stopAll = async () => {
  if (!confirm("稼働中・待機中のジョブを全部強制停止します。")) return;
  const r = await api("/api/jobs/stop-all", { method: "POST" });
  alert(`${r.changed || 0} 件を停止しました`);
  loadJobs();
};

let timer = null, lastId = 0;
async function openJob(id) {
  clearInterval(timer);
  lastId = 0;
  $("detail").innerHTML = `<h3>ジョブ #${id}</h3><pre id="logs"></pre>`;

  const tick = async () => {
    let r;
    try { r = await api(`/api/jobs/${id}?after=${lastId}`); }
    catch { clearInterval(timer); return; }
    if (!r.job) { clearInterval(timer); return; }

    const el = $("logs");
    for (const l of r.logs) {
      lastId = l.id;
      el.textContent += `${new Date(l.ts).toLocaleTimeString()} [${l.level}${l.code ? " " + l.code : ""}] ${l.msg}\n`;
    }
    el.scrollTop = el.scrollHeight;

    $("detail").querySelector("h3").textContent =
      `ジョブ #${id} — ${r.job.status} 成功 ${r.job.sent} / 失敗 ${r.job.failed}`;

    if (["done", "stopped", "failed"].includes(r.job.status)) {
      clearInterval(timer);
      loadJobs();
    }
  };

  tick();
  timer = setInterval(tick, 2000);
}

$("u").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
$("p").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });

setInterval(() => { if (!$("app").hidden) loadJobs().catch(() => {}); }, 5000);

boot().catch(() => {});