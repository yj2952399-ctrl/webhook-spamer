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

    if (p === "/api/webhooks") {
      if (m === "GET") return api.listHooks(env, me);
      if (m === "POST") return api.addHooks(req, env, me);
    }

    const wh = p.match(/^\/api\/webhooks\/(\d+)$/);
    if (wh && m === "DELETE") return api.delHook(env, me, Number(wh[1]));

    if (p === "/api/jobs") {
      if (m === "GET") return api.listJobs(env, me);
      if (m === "POST") return api.createJob(req, env, me);
    }

    const jb = p.match(/^\/api\/jobs\/(\d+)(\/stop)?$/);
    if (jb) {
      if (jb[2] && m === "POST") return api.stopJob(env, me, Number(jb[1]));
      if (m === "GET") return api.getJob(url, env, me, Number(jb[1]));
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(_event, env) {
    await tick(env);
  },
};