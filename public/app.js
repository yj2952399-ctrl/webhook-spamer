const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const ACTIVE = ["queued", "running", "stopping"];
let targetSet = new Set();

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

  const d = await api("/api/discord");
  if (d.token_set) $("d-token").placeholder = `保存済み (${d.token_hint})`;
  if (d.guild_id) $("d-guild").value = d.guild_id;

  targetSet = new Set((s.target_channels || []).map(String));
  loadChannels(); loadHooks(); loadJobs();
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

/* ---- 対象チャンネル ---- */

async function loadChannels() {
  const list = await api("/api/channels");
  $("targets").innerHTML = list.length
    ? list.map((c) =>
      `<label class="ch"><input type="checkbox" value="${esc(c.channel_id)}"
        ${targetSet.has(String(c.channel_id)) ? "checked" : ""}>
       #${esc(c.channel_name || c.channel_id)} <span class="note">${c.hooks} 本</span></label>`).join("")
    : `<div class="note">チャンネル情報つきの Webhook がありません（手動追加でチャンネルIDを入れるか、自動発行してください）</div>`;
}

const allTargets = () =>
  document.querySelectorAll("#targets input").forEach((el) => { el.checked = true; });
const noneTargets = () =>
  document.querySelectorAll("#targets input").forEach((el) => { el.checked = false; });

/* ---- Webhook 手動 ---- */

async function addHooks() {
  const r = await api("/api/webhooks", {
    method: "POST",
    body: JSON.stringify({
      label: $("hlabel").value,
      urls: $("hurls").value,
      channel_id: $("hchannel").value,
    }),
  });
  if (!r.ok) return alert(r.error || "追加できませんでした");
  $("hurls").value = "";
  alert(`追加 ${r.added} 件 / 更新 ${r.updated || 0} 件`);
  loadHooks(); loadChannels();
}

async function loadHooks() {
  const list = await api("/api/webhooks");
  $("hlist").innerHTML = list.length
    ? list.map((h) =>
      `<li>${h.channel_id ? `<span class="note">#${esc(h.channel_name || h.channel_id)}</span>` : ""}
       <b>${esc(h.label || "-")}</b> <code>…${esc(h.url.slice(-10))}</code>
       <button onclick="delHook(${h.id})">削除</button></li>`).join("")
    : `<li class="note">まだ登録がありません</li>`;
}

const delHook = async (id) => { await api("/api/webhooks/" + id, { method: "DELETE" }); loadHooks(); loadChannels(); };

const clearHooks = async () => {
  if (!confirm("登録済みの Webhook を全部消します。")) return;
  const r = await api("/api/webhooks", { method: "DELETE" });
  alert(`${r.deleted || 0} 件削除しました`);
  loadHooks(); loadChannels();
};

/* ---- トークン / 自動発行 ---- */

async function saveDiscord() {
  const r = await api("/api/discord", {
    method: "PUT",
    body: JSON.stringify({ token: $("d-token").value, guild_id: $("d-guild").value }),
  });
  if (!r.ok) return alert(r.error || "保存失敗");
  $("d-token").value = "";
  $("d-token").placeholder = "保存済み";
  alert("保存しました");
}

async function checkDiscord() {
  $("d-info").textContent = "確認中…";
  $("d-channels").innerHTML = "";
  const r = await api("/api/discord/check", { method: "POST" });
  if (!r.ok) { $("d-info").textContent = r.error || "確認失敗"; return; }

  const usable = r.channels.filter((c) => c.can).length;
  $("d-info").innerHTML =
    `${esc(r.user.bot ? "BOT" : "ユーザー")} <b>${esc(r.user.name)}</b> / ` +
    `サーバー <b>${esc(r.guild.name)}</b> — 発行可能 ${usable} チャンネル`;

  const dflt = Number($("d-count").value) || 0;
  $("d-channels").innerHTML = r.channels.length
    ? r.channels.map((c) =>
      `<div class="ch">
         <label><input type="checkbox" value="${c.id}" ${c.can ? "checked" : "disabled"}>
         #${esc(c.name)}${c.can ? "" : " <span class=\"note\">権限なし</span>"}</label>
         <input class="cnt" data-id="${c.id}" type="number" min="0" max="10"
           value="${c.can ? dflt : 0}" ${c.can ? "" : "disabled"}>
       </div>`).join("")
    : `<div class="note">テキストチャンネルが見つかりません</div>`;
}

const fillCounts = () => {
  const n = Math.min(Math.max(Number($("d-count").value) || 0, 0), 10);
  document.querySelectorAll("#d-channels .cnt").forEach((el) => {
    if (!el.disabled) el.value = n;
  });
};

async function autoHooks() {
  const channels = [];
  for (const cb of document.querySelectorAll("#d-channels input[type=checkbox]")) {
    if (!cb.checked || cb.disabled) continue;
    const el = document.querySelector(`#d-channels .cnt[data-id="${cb.value}"]`);
    const count = Math.min(Math.max(Number(el?.value) || 0, 0), 10);
    if (count > 0) channels.push({ id: cb.value, count });
  }
  if (!channels.length) return alert("チャンネルと発行数を指定してください");

  const sum = channels.reduce((a, c) => a + c.count, 0);
  if (!confirm(`${channels.length} チャンネルに計 ${sum} 個の Webhook を発行します。よろしいですか？`)) return;

  const r = await api("/api/webhooks/auto", {
    method: "POST",
    body: JSON.stringify({ channels }),
  });

  if (!r.ok) return alert(r.error || "発行できませんでした");

  let msg = `作成 ${r.created} 件 / 登録 ${r.added} 件`;
  if (r.updated) msg += `（既存 ${r.updated} 件は紐付け更新）`;
  if (r.skipped) msg += `（登録不可 ${r.skipped} 件）`;
  if (r.created > 0 && r.added + (r.updated || 0) === 0) {
    msg += "\n\n※ 作成自体は成功しています。下の内容を確認してください。";
  }
  if (r.errors?.length) msg += `\n\n${r.errors.join("\n")}`;
  alert(msg);

  loadHooks(); loadChannels();
}

/* ---- ジョブ ---- */

async function startJob() {
  const total = Number($("total").value);
  if (!Number.isFinite(total) || total < 1) return alert("投稿数を入れてください");

  const channels = [...document.querySelectorAll("#targets input:checked")].map((el) => el.value);
  if (channels.length) {
    const ok = confirm(`${channels.length} チャンネル分の Webhook だけに ${total} 通送ります。よろしいですか？`);
    if (!ok) return;
  }

  const body = () => JSON.stringify({ total, channels });

  let r = await api("/api/jobs", { method: "POST", body: body() });

  if (r.__status === 409) {
    if (!confirm(`${r.error}\n強制停止してから開始しますか？`)) return;
    await api("/api/jobs/stop-all", { method: "POST" });
    r = await api("/api/jobs", { method: "POST", body: body() });
  }

  if (!r.id) return alert(r.error || "開始できませんでした");
  alert("ジョブ #" + r.id + " を登録しました。最大 60 秒で動き出します。");
  loadJobs();
}

async function loadJobs() {
  const jobs = await api("/api/jobs");
  const active = jobs.filter((j) => ACTIVE.includes(j.status));

  $("active").innerHTML = active.length
    ? active.map((j) =>
      `<div class="card">稼働中: #${j.id} <b>${esc(j.status)}</b> ${j.sent}/${j.total}
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
        : ""}
       <button class="danger" onclick="deleteJob(${j.id})">削除</button></li>`).join("")
    : `<li class="note">履歴はありません</li>`;
}

const stopJob = async (id) => {
  const r = await api(`/api/jobs/${id}/stop`, { method: "POST" });
  if (r.already) alert(`#${id} はすでに ${r.status} です`);
  loadJobs();
};

const forceStop = async (id) => {
  if (!confirm(`ジョブ #${id} を強制停止します。送信中の分は打ち切られます。`)) return;
  const r = await api(`/api/jobs/${id}/stop?force=1`, { method: "POST" });
  if (!r.ok) alert(r.error || "失敗しました");
  loadJobs();
};

const deleteJob = async (id) => {
  if (!confirm(`ジョブ #${id} とログを削除します。`)) return;
  await api(`/api/jobs/${id}`, { method: "DELETE" });
  loadJobs();
};

const stopAll = async () => {
  if (!confirm("稼働中・待機中を全部強制停止します。")) return;
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