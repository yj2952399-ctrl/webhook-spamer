const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  if (r.status === 401) { $("app").hidden = true; $("auth").hidden = false; throw new Error("401"); }
  return r.json();
}

const register = async () => {
  const r = await api("/api/register", { method: "POST", body: JSON.stringify({ username: $("u").value, password: $("p").value }) });
  r.ok ? boot() : alert(r.error);
};
const login = async () => {
  const r = await api("/api/login", { method: "POST", body: JSON.stringify({ username: $("u").value, password: $("p").value }) });
  r.ok ? boot() : alert(r.error);
};

document.querySelectorAll("nav button").forEach((b) => b.onclick = () => {
  document.querySelectorAll(".tab").forEach((t) => t.hidden = true);
  $("tab-" + b.dataset.tab).hidden = false;
});

async function boot() {
  const me = await api("/api/me");
  $("who").textContent = me.username;
  $("auth").hidden = true; $("app").hidden = false;
  const s = await api("/api/settings");
  for (const [k, v] of Object.entries(s)) {
    const el = $("s-" + k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!v; else el.value = v;
  }
  loadHooks(); loadJobs();
}

async function saveSettings() {
  const b = {};
  document.querySelectorAll("[id^=s-]").forEach((el) => {
    const k = el.id.slice(2);
    b[k] = el.type === "checkbox" ? (el.checked ? 1 : 0)
      : el.type === "number" ? Number(el.value) : el.value;
  });
  await api("/api/settings", { method: "PUT", body: JSON.stringify(b) });
  alert("保存しました");
}

async function addHooks() {
  await api("/api/webhooks", { method: "POST", body: JSON.stringify({ label: $("hlabel").value, urls: $("hurls").value }) });
  $("hurls").value = ""; loadHooks();
}
async function loadHooks() {
  const list = await api("/api/webhooks");
  $("hlist").innerHTML = list.map((h) =>
    `<li><b>${esc(h.label || "-")}</b> <code>${esc(h.url.slice(-12))}</code>
     <button onclick="delHook(${h.id})">削除</button></li>`).join("");
}
const delHook = async (id) => { await api("/api/webhooks/" + id, { method: "DELETE" }); loadHooks(); };

async function startJob() {
  const r = await api("/api/jobs", { method: "POST", body: JSON.stringify({ total: Number($("total").value) }) });
  alert("ジョブ #" + r.id + " を登録しました");
  loadJobs();
}

async function loadJobs() {
  const jobs = await api("/api/jobs");
  $("jlist").innerHTML = jobs.map((j) =>
    `<li>#${j.id} <b>${esc(j.status)}</b> ${j.sent}/${j.total}（失敗 ${j.failed}）
     <button onclick="openJob(${j.id})">詳細</button>
     ${["queued", "running"].includes(j.status) ? `<button onclick="stopJob(${j.id})">停止</button>` : ""}</li>`).join("");
}
const stopJob = async (id) => { await api(`/api/jobs/${id}/stop`, { method: "POST" }); loadJobs(); };

let timer = null, lastId = 0;
async function openJob(id) {
  clearInterval(timer); lastId = 0;
  $("detail").innerHTML = `<h3>ジョブ #${id}</h3><pre id="logs"></pre>`;
  const tick = async () => {
    const r = await api(`/api/jobs/${id}?after=${lastId}`);
    const el = $("logs");
    for (const l of r.logs) {
      lastId = l.id;
      el.textContent += `${new Date(l.ts).toLocaleTimeString()} [${l.level}${l.code ? " " + l.code : ""}] ${l.msg}\n`;
    }
    el.scrollTop = el.scrollHeight;
    $("detail").querySelector("h3").textContent =
      `ジョブ #${id} — ${r.job.status} 成功 ${r.job.sent} / 失敗 ${r.job.failed}`;
    if (["done", "stopped", "failed"].includes(r.job.status)) { clearInterval(timer); loadJobs(); }
  };
  tick(); timer = setInterval(tick, 2000);
}

boot().catch(() => {});