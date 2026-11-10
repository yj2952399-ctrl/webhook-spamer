// 起動時に不足列を補う。ビルド設定に依存せず、二重実行しても壊れない
let ready = false;

async function cols(env, table) {
  const { results } = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((results || []).map((r) => r.name));
}

async function add(env, table, col, ddl) {
  const have = await cols(env, table);
  if (have.has(col)) return false;
  try {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
    return true;
  } catch {
    return false; // 同時実行で既に追加された場合など
  }
}

export async function ensureSchema(env) {
  if (ready) return;
  try {
    await add(env, "webhooks", "channel_id", "channel_id TEXT NOT NULL DEFAULT ''");
    await add(env, "webhooks", "channel_name", "channel_name TEXT NOT NULL DEFAULT ''");
    await add(env, "settings", "target_channels", "target_channels TEXT NOT NULL DEFAULT ''");
    try {
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS idx_hooks_channel ON webhooks(user_id, channel_id)").run();
    } catch {}
    ready = true;
  } catch {}
}