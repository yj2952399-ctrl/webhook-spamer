import { rand } from "./util.js";

export const DEFAULT_SETTINGS = {
  content: "{i}", delay: 0.35, jitter: 0.15, concurrency: 1, retries: 4,
  ping_everyone: 0, embed: 0, embed_title: "{rand}", embed_desc: "{i}",
  embed_color: 0x5865f2, image: "", thumbnail: "", tts: 0,
  username_override: "", avatar: "", delete_webhook: 0, log_mode: "sample",
};

export function build(cfg, n) {
  const sub = (s) => String(s ?? "")
    .replaceAll("{i}", String(n))
    .replaceAll("{rand}", rand())
    .replaceAll("{time}", new Date().toISOString().slice(11, 19));

  const payload = { content: sub(cfg.content).slice(0, 2000) };
  if (cfg.ping_everyone) {
    payload.content = ("@everyone " + payload.content).slice(0, 2000);
    payload.allowed_mentions = { parse: ["everyone", "roles", "users"] };
  }
  if (cfg.username_override) payload.username = sub(cfg.username_override).slice(0, 80);
  if (cfg.avatar) payload.avatar_url = cfg.avatar;
  if (cfg.tts) payload.tts = true;
  if (cfg.embed) {
    const e = {
      title: sub(cfg.embed_title).slice(0, 256),
      description: sub(cfg.embed_desc).slice(0, 4000),
      color: Number(cfg.embed_color) || 0x5865f2,
    };
    if (cfg.image) e.image = { url: cfg.image };
    if (cfg.thumbnail) e.thumbnail = { url: cfg.thumbnail };
    payload.embeds = [e];
  }
  return payload;
}