import argparse, asyncio
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from whook import Raider

DEFAULTS = dict(webhook=[], webhook_file=None, rename=None, count=0, duration=0,
                delay=0.34, jitter=0.15, concurrency=1, retries=6, timeout=15.0,
                content="{i}", text_file=None, shuffle=False, username=None,
                avatar=None, tts=False, ping=[], attach=None, embed=False,
                embed_title="{rand}", embed_desc="{i}", embed_color=0x5865F2,
                image=None, thumbnail=None, delete_webhook=False, dry_run=False)

app = FastAPI()
state = {"task": None, "raider": None}

class StartIn(BaseModel):
    webhooks: str
    count: int = 100
    content: str = "{i}"
    ping_everyone: bool = False
    embed: bool = False
    delete_webhook: bool = False
    concurrency: int = 1
    delay: float = 0.34

@app.get("/", response_class=HTMLResponse)
def index():
    return """<!doctype html><meta charset=utf-8>
<body style="font-family:system-ui;max-width:640px;margin:40px auto">
<h2>Webhook Raider</h2>
<textarea id=w rows=4 style="width:100%" placeholder="Webhook URL を1行1本"></textarea>
<p><input id=c type=number value=100> 件
 / 本文 <input id=t value="{i}">
 / 並列 <input id=p type=number value=1 style="width:4em"></p>
<p><label><input id=e type=checkbox> @everyone</label>
 / <label><input id=d type=checkbox> 終了後 Webhook 削除</label></p>
<button onclick=go()>開始</button> <button onclick=stop()>停止</button>
<pre id=s></pre>
<script>
async function go(){
  const b={webhooks:w.value,count:+c.value,content:t.value,
           ping_everyone:e.checked,delete_webhook:d.checked,concurrency:+p.value};
  await fetch('/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});
  poll();
}
async function stop(){ await fetch('/stop',{method:'POST'}); }
async function poll(){
  const r=await (await fetch('/status')).json();
  s.textContent=`送信 ${r.sent} / 失敗 ${r.failed} / ${r.running?'稼働中':'停止'}`;
  if(r.running) setTimeout(poll,1000);
}
</script>"""

@app.post("/start")
async def start(b: StartIn):
    if state["task"] and not state["task"].done():
        return {"error": "already running"}
    a = argparse.Namespace(**DEFAULTS)
    a.webhook = [x.strip() for x in b.webhooks.splitlines() if "webhooks/" in x]
    a.count, a.content, a.embed = b.count, b.content, b.embed
    a.ping = ["everyone"] if b.ping_everyone else []
    a.delete_webhook, a.concurrency, a.delay = b.delete_webhook, b.concurrency, b.delay
    if not a.webhook:
        return {"error": "no webhook"}
    r = Raider(a.webhook, a)
    r.load_assets()
    state["raider"] = r
    state["task"] = asyncio.create_task(r.run())
    return {"ok": True}

@app.post("/stop")
async def stop():
    if state["raider"]:
        state["raider"].stop.set()
    return {"ok": True}

@app.get("/status")
def status():
    r = state["raider"]
    return {"sent": r.sent if r else 0, "failed": r.failed if r else 0,
            "running": bool(state["task"] and not state["task"].done())}