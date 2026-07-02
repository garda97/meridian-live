# GETXAPI — Baca thread X untuk Hermes

Hermes pakai [GetXAPI](https://www.getxapi.com/dashboard) untuk baca thread X/Twitter (materi LP Meteora, narrative pool, dll).

## Setup (sekali)

1. Ambil API key di https://www.getxapi.com/dashboard
2. Simpan key:
   ```bash
   echo 'get-x-api-...' > ~/.meridian/secrets/getxapi.key
   chmod 600 ~/.meridian/secrets/getxapi.key
   ```
3. Cek MCP terpasang:
   ```bash
   hermes mcp list
   hermes mcp test getxapi
   ```

## Cara pakai di sesi Hermes

**Via MCP tool** (setelah restart sesi `hermes chat`):
- `get_tweet_thread` — resolve full self-thread dari tweet ID atau URL
- `advanced_search_tweets` — cari tweet by keyword
- `get_tweet_detail` — detail satu tweet

Contoh prompt ke Hermes:
```
Baca thread ini pakai get_tweet_thread: https://x.com/.../status/1234567890
Rangkum poin utama tentang Meteora DLMM untuk screening.
```

**Via CLI** (fallback tanpa MCP):
```bash
cd /root/meridian
python3 scripts/x_thread.py "https://x.com/user/status/1234567890"
```

## Auth

- Header: `Authorization: Bearer <GETXAPI_KEY>`
- Hanya **read** tools — tidak perlu login X (`x_login`) untuk baca thread
- Biaya: ~$0.005 per `get_tweet_thread` call (cek dashboard credits)

## Troubleshooting

| Error | Fix |
|-------|-----|
| `Invalid API key` | Key expired/salah — generate baru di dashboard |
| MCP tidak muncul | `hermes mcp list` → `hermes mcp test getxapi` → buka sesi chat baru |
| `Missing GETXAPI_KEY` | Isi `~/.meridian/secrets/getxapi.key` |

## Key locations (priority)

1. `GETXAPI_KEY` env var
2. `~/.meridian/secrets/getxapi.key`
3. Legacy `~/.config/screening_g97/secrets/api_keys.json`