import { json } from "./util.js";
import { register, login, logout, currentUser } from "./auth.js";
import * as api from "./api.js";
import { tick } from "./engine.js";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const m = req.method;

    if (p === "/api/register" && m === "POST") return register(req, env);
    if (p === "/api/login" && m === "POST") return login(req, env);
    if (p === "/api/logout" && m === "POST") return logout(req, env);

    if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);

    const me = await currentUser(req, env);
    if (!me) return json({ error: "未ログイン" }, 401);

    if (p === "/api/me") return json({ id: me.id, username: me.username });

    if (p === "/api/settings") {
      if (m === "GET") return api.getSettings(env, me);
      if (m === "PUT") return api.putSettings(req, env, me);
    }

    if (p === "/api/discord") {
      if (m === "GET") return api.getDiscord(env, me);
      if (m === "PUT") return api.putDiscord(req, env, me);
    }
    if (p === "/api/discord/check" && m === "POST") return api.checkDiscord(env, me);

    if (p === "/api/webhooks") {
      if (m === "GET") return api.listHooks(env, me);
      if (m === "POST") return api.addHooks(req, env, me);
      if (m === "DELETE") return api.clearHooks(env, me, url.searchParams.get("channel") || "");
    }
    if (p === "/api/webhooks/auto" && m === "POST") return api.autoHooks(req, env, me);
    if (p === "/api/channels" && m === "GET") return api.listChannels(env, me);

    const wh = p.match(/^\/api\/webhooks\/(\d+)$/);
    if (wh && m === "DELETE") return api.delHook(env, me, Number(wh[1]));

    if (p === "/api/jobs") {
      if (m === "GET") return api.listJobs(env, me);
      if (m === "POST") return api.createJob(req, env, me);
    }

    if (p === "/api/jobs/stop-all" && m === "POST") return api.stopAllJobs(env, me);

    const jb = p.match(/^\/api\/jobs\/(\d+)(\/stop)?$/);
    if (jb) {
      const id = Number(jb[1]);
      if (jb[2] && m === "POST") {
        const force = ["1", "true", "yes"].includes(url.searchParams.get("force") || "");
        return api.stopJob(env, me, id, force);
      }
      if (!jb[2] && m === "GET") return api.getJob(url, env, me, id);
      if (!jb[2] && m === "DELETE") return api.deleteJob(env, me, id);
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};