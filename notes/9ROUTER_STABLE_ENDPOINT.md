# 9router — Link Permanen (tidak expire)

## Masalah

Link **trycloudflare.com** dari tunnel bawaan 9router **expire** tiap `cloudflared` restart.

## Link permanen (aktif)

| Pakai untuk | URL |
|-------------|-----|
| **Hermes / Meridian di VPS ini** | `http://127.0.0.1:20128/v1` |
| **HP / laptop / luar VPS (HTTPS)** | `https://screeningg97.devs.surf/9router/v1` |
| **Dashboard 9router remote** | `https://screeningg97.devs.surf/9router/` |

API key: `Authorization: Bearer <key>` — sama seperti provider `9router` di `~/.hermes/config.yaml`.

File metadata: `~/.9router/stable-endpoint.json`

## Hermes

- Default: `custom:9router` → localhost (jangan ubah ke trycloudflare)
- Remote: `custom:9router-stable` → `https://screeningg97.devs.surf/9router/v1`

## Infra

Caddy (`/etc/caddy/Caddyfile`) — `handle_path /9router/*` → `127.0.0.1:20128`

```bash
# Cek
curl -s https://screeningg97.devs.surf/9router/v1/models \
  -H "Authorization: Bearer <api_key>" | head -c 200

# Matikan quick tunnel lama
bash /root/meridian/scripts/9router-stable-endpoint.sh stop-tunnel
```

## Jangan pakai

- URL `*.trycloudflare.com` dari toggle tunnel di UI 9router
- Provider `Compliant-bald-opposite-presented.trycloudflare.com` (sudah dihapus)