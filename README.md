# raider

Discord Webhook 連投サイト。Cloudflare Workers + D1 の無料枠で動く。

## デプロイ

    npm i -g wrangler
    wrangler login
    wrangler d1 create raider
    # 出力の database_id を wrangler.toml に貼る
    wrangler d1 execute raider --remote --file=schema.sql
    wrangler deploy

## ローカル

    wrangler d1 execute raider --local --file=schema.sql
    wrangler dev

## 無料枠の内訳と対策

| 項目 | 無料枠 | 本実装の対策 |
| --- | --- | --- |
| CPU | 10ms/実行 | PBKDF2 10,000 回、1 起動 40 通まで |
| リクエスト | 10 万/日 | cron は 1,440 回/日 |
| D1 書き込み | 10 万行/日 | ログは成功 1/10 ＋ エラー全件 |
| cron | 無料 | 毎分 1 回、40 秒で打ち切り |

CPU エラーが頻発するなら ITER を 5000 に落とすか、Workers Paid（$5/月）に上げる。