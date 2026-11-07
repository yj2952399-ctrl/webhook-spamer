-- 1) 列の追加
ALTER TABLE jobs ADD COLUMN lock_at INTEGER;

-- 2) 既存行の NULL を既定値で埋める
UPDATE settings SET content        = '{i}'     WHERE content        IS NULL OR content        = '';
UPDATE settings SET delay          = 0.35      WHERE delay          IS NULL;
UPDATE settings SET jitter         = 0.15      WHERE jitter         IS NULL;
UPDATE settings SET concurrency    = 1         WHERE concurrency    IS NULL;
UPDATE settings SET retries        = 4         WHERE retries        IS NULL;
UPDATE settings SET ping_everyone  = 0         WHERE ping_everyone  IS NULL;
UPDATE settings SET embed          = 0         WHERE embed          IS NULL;
UPDATE settings SET embed_title    = '{rand}'  WHERE embed_title    IS NULL OR embed_title    = '';
UPDATE settings SET embed_desc     = '{i}'     WHERE embed_desc     IS NULL OR embed_desc     = '';
UPDATE settings SET embed_color    = 5793266   WHERE embed_color    IS NULL;
UPDATE settings SET image          = ''        WHERE image          IS NULL;
UPDATE settings SET thumbnail      = ''        WHERE thumbnail      IS NULL;
UPDATE settings SET tts            = 0         WHERE tts            IS NULL;
UPDATE settings SET username_override = ''     WHERE username_override IS NULL;
UPDATE settings SET avatar         = ''        WHERE avatar         IS NULL;
UPDATE settings SET delete_webhook = 0         WHERE delete_webhook IS NULL;
UPDATE settings SET log_mode       = 'sample'  WHERE log_mode       IS NULL OR log_mode NOT IN ('sample','all','errors');

-- 3) settings 行が無いユーザーを補完
INSERT INTO settings (user_id)
SELECT id FROM users WHERE id NOT IN (SELECT user_id FROM settings);