import { rand, clamp, urlOk } from "./util.js";

export const DEFAULT_SETTINGS = {
  content: "{i}", delay: 0.35, jitter: 0.15, concurrency: 1, retries: 4,
  ping_everyone: 0, embed: 0, embed_title: "{rand}", embed_desc: "{i}",
  embed_color: 0x5865f2, image: "", thumbnail: "", tts: 0,
  username_override: "", avatar: "", delete_webhook: 0, log_mode: "sample",
};

const LOG_MODES = ["sample", "all", "errors"];

/** NULL / undefined / 空文字を既定値で埋める（DB 由来の値に使う） */
export function normalizeSettings(row) {
  const out = { ...DEFAULT_SETTINGS };
  for (const [k, v] of Object.entries(row || {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    out[k] = v;
  }
  return out;
}

/** 保存用：型・範囲・空文字をすべて矯正する */
export function normalizeInput(body) {
  const v = normalizeSettings(body);

  v.content = String(v.content ?? "").trim() || DEFAULT_SETTINGS.content;
  v.embed_title = String(v.embed_title ?? "").trim() || DEFAULT_SETTINGS.embed_title;
  v.embed_desc = String(v.embed_desc ?? "").trim() || DEFAULT_SETTINGS.embed_desc;

  v.delay = clamp(v.delay, 0, 10, DEFAULT_SETTINGS.delay);
  v.jitter = clamp(v.jitter, 0, 5, DEFAULT_SETTINGS.jitter);
  v.concurrency = Math.round(clamp(v.concurrency, 1, 3, DEFAULT_SETTINGS.concurrency));
  v.retries = Math.round(clamp(v.retries, 0, 8, DEFAULT_SETTINGS.retries));

  v.embed_color = Math.round(clamp(v.embed_color, 0, 0xffffff, DEFAULT_SETTINGS.embed_color));
  v.ping_everyone = v.ping_everyone ? 1 : 0;
  v.embed = v.embed ? 1 : 0;
  v.tts = v.tts ? 1 : 0;
  v.delete_webhook = v.delete_webhook ? 1 : 0;

  v.image = urlOk(v.image) ? String(v.image).trim() : "";
  v.thumbnail = urlOk(v.thumbnail) ? String(v.thumbnail).trim() : "";
  v.avatar = urlOk(v.avatar) ? String(v.avatar).trim() : "";

  v.username_override = String(v.username_override ?? "").trim().slice(0, 80);
  v.log_mode = LOG_MODES.includes(v.log_mode) ? v.log_mode : DEFAULT_SETTINGS.log_mode;

  return v;
}

export function build(cfg, n) {
  const sub = (s) => String(s ?? "")
    .replaceAll("{i}", String(n))
    .replaceAll("{rand}", rand())
    .replaceAll("{time}", new Date().toISOString().slice(11, 19));

  const plain = sub(cfg.content).trim();
  const withPing = cfg.ping_everyone ? `@everyone ${plain}`.trim() : plain;

  const payload = { content: withPing.slice(0, 2000) };
  if (cfg.ping_everyone) {
    payload.allowed_mentions = { parse: ["everyone", "roles", "users"] };
  }
  if (cfg.username_override) payload.username = sub(cfg.username_override).slice(0, 80);
  if (cfg.avatar && urlOk(cfg.avatar)) payload.avatar_url = String(cfg.avatar).trim();
  if (cfg.tts) payload.tts = true;

  if (cfg.embed) {
    const title = sub(cfg.embed_title).trim().slice(0, 256);
    const desc = sub(cfg.embed_desc).trim().slice(0, 4000);
    const color = Number(cfg.embed_color);
    const e = {
      color: Number.isFinite(color) ? Math.min(Math.max(Math.trunc(color), 0), 0xffffff) : 0x5865f2,
    };
    // タイトルが空でも本文か連番で必ず埋める（空の埋め込みは 400 になる）
    e.title = title || plain.slice(0, 256) || String(n);
    if (desc) e.description = desc;
    if (cfg.image && urlOk(cfg.image)) e.image = { url: String(cfg.image).trim() };
    if (cfg.thumbnail && urlOk(cfg.thumbnail)) e.thumbnail = { url: String(cfg.thumbnail).trim() };
    payload.embeds = [e];
  }

  return payload;
}