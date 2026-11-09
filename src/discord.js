const API = "https://discord.com/api/v10";
const UA = "DiscordBot (https://github.com/yj2952399-ctrl/webhook-spamer, 1.1)";

const ADMIN = 0x8n;
const MANAGE_WEBHOOKS = 0x20n;
const VIEW_CHANNEL = 0x400n;
const TEXT_TYPES = new Set([0, 5]);
export const PER_CHANNEL_MAX = 10;

export class DiscordError extends Error {
  constructor(msg, status = 0) { super(msg); this.status = status; }
}

async function dapi(path, auth, { method = "GET", body } = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: {
        authorization: auth,
        "content-type": "application/json",
        "user-agent": UA,
        "x-ratelimit-precision": "millisecond",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429) {
      let w = 1;
      try { w = Number((await res.json()).retry_after) || 1; } catch {}
      await new Promise((r) => setTimeout(r, Math.min(w, 5) * 1000));
      continue;
    }

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data };
  }
  throw new DiscordError("レート制限が続いています", 429);
}

async function resolveAuth(token) {
  const raw = token.trim();
  let auth = raw.startsWith("Bot ") ? raw : raw;
  let me = await dapi("/users/@me", auth);

  if (me.status === 401 && !raw.startsWith("Bot ")) {
    auth = "Bot " + raw;
    me = await dapi("/users/@me", auth);
  }
  if (me.status !== 200) {
    throw new DiscordError(me.status === 401 ? "トークンが無効です" : `トークン確認に失敗 (${me.status})`, me.status);
  }
  return { auth, me: me.data, isBot: !!me.data.bot };
}

/** ギルド・権限・チャンネルを調べて返す */
export async function inspect(token, guildId) {
  const { auth, me, isBot } = await resolveAuth(token);

  const guild = await dapi(`/guilds/${guildId}`, auth);
  if (guild.status === 404) throw new DiscordError("サーバーが見つかりません（未参加の可能性）", 404);
  if (guild.status !== 200) throw new DiscordError(`サーバー取得に失敗 (${guild.status})`, guild.status);

  const chans = await dapi(`/guilds/${guildId}/channels`, auth);
  if (chans.status === 403) throw new DiscordError("チャンネル一覧の権限がありません", 403);
  if (chans.status !== 200) throw new DiscordError(`チャンネル取得に失敗 (${chans.status})`, chans.status);

  let base = 0n;
  const roleIds = new Set();

  if (isBot) {
    const member = await dapi(`/guilds/${guildId}/members/${me.id}`, auth);
    if (member.status !== 200) throw new DiscordError("BOT がそのサーバーにいません", member.status);
    const all = await dapi(`/guilds/${guildId}/roles`, auth);
    const roleMap = new Map((all.data || []).map((r) => [r.id, BigInt(r.permissions || "0")]));
    base |= roleMap.get(guildId) || 0n;
    for (const rid of member.data.roles || []) {
      roleIds.add(rid);
      base |= roleMap.get(rid) || 0n;
    }
  } else {
    const mine = await dapi("/users/@me/guilds", auth);
    const g = (mine.data || []).find((x) => x.id === guildId);
    if (!g) throw new DiscordError("そのサーバーに参加していません", 404);
    base = BigInt(g.permissions || "0");
  }

  const isAdmin = (base & ADMIN) === ADMIN;

  const channels = [];
  for (const c of chans.data || []) {
    if (!TEXT_TYPES.has(c.type)) continue;

    let p = base;
    if (!isAdmin) {
      const ow = c.permission_overwrites || [];
      const ev = ow.find((o) => o.id === guildId);
      if (ev) p = (p & ~BigInt(ev.deny || "0")) | BigInt(ev.allow || "0");

      let allow = 0n, deny = 0n;
      for (const o of ow) {
        if (!roleIds.has(o.id)) continue;
        allow |= BigInt(o.allow || "0");
        deny |= BigInt(o.deny || "0");
      }
      p = (p & ~deny) | allow;
    }

    const can = isAdmin
      || ((p & VIEW_CHANNEL) === VIEW_CHANNEL && (p & MANAGE_WEBHOOKS) === MANAGE_WEBHOOKS);

    channels.push({ id: c.id, name: c.name, type: c.type, position: c.position ?? 0, can });
  }

  channels.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

  return {
    auth,
    user: { id: me.id, name: me.username, bot: isBot },
    guild: { id: guild.data.id, name: guild.data.name },
    channels,
  };
}

/**
 * チャンネルごとの quota に従って作る。
 * quota: Map<channelId, number> / limit: 総数の上限
 */
export async function createWebhooks(auth, channels, quota, limit = Infinity) {
  const created = [];
  const errors = [];
  const left = new Map(channels.map((c) => [
    c.id, Math.min(Math.max(Number(quota.get(c.id)) || 0, 0), PER_CHANNEL_MAX),
  ]));
  const dead = new Set();

  // 1 チャンネルに固まらないようラウンドロビンで並べる
  const plan = [];
  let more = true;
  while (more && plan.length < limit) {
    more = false;
    for (const c of channels) {
      const n = left.get(c.id) || 0;
      if (n <= 0) continue;
      left.set(c.id, n - 1);
      plan.push(c);
      more = true;
      if (plan.length >= limit) break;
    }
  }

  for (const target of plan) {
    if (dead.has(target.id)) continue;

    const r = await dapi(`/channels/${target.id}/webhooks`, auth, {
      method: "POST",
      body: { name: "raider" },
    });

    if (r.status === 200 && r.data?.url) {
      created.push({ channelId: target.id, name: target.name, url: r.data.url });
      continue;
    }

    if (r.status === 403) { errors.push(`#${target.name}: 権限なし`); dead.add(target.id); continue; }
    if (r.status === 400 && /maximum/i.test(JSON.stringify(r.data || ""))) { dead.add(target.id); continue; }

    errors.push(`#${target.name}: ${r.status}`);
    dead.add(target.id);
  }

  return { created, errors };
}