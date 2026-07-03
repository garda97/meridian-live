# Discord Listener — Setup & Login (untuk Hermes / Grok)

Meridian punya proses terpisah `meridian-discord` yang baca channel Discord untuk signal pool DLMM.

**Jangan minta password/email Discord di chat.** Cukup **user token** atau **bot token**.

---

## Arsitektur singkat

| Komponen | Path / service |
|----------|----------------|
| Listener code | `discord-listener/index.js` |
| Pre-check + screening gate | `discord-listener/pre-checks.js` |
| Signal queue | `discord-signals.json` (root repo) |
| Systemd | `meridian-discord.service` |
| Config env | `/root/meridian/.env` |
| Screening merge | `user-config.json` → `useDiscordSignals: true` |

Flow: **Rick bot post** → extract Solana address → pre-check (dedup, blacklist, pool, rug, fees, screening gate) → `discord-signals.json` → daemon screening merge → filter penuh lagi sebelum deploy.

---

## Dua mode login

### Mode A — User token (selfbot) **← dipakai sekarang**

Akun Discord **personal/secondary** yang sudah join server. Cocok kalau bot official gak di-invite ke guild.

```env
DISCORD_AUTH_MODE=user
DISCORD_USER_TOKEN=<token_dari_browser>
DISCORD_BOT_TOKEN=          # boleh ada, diabaikan saat AUTH_MODE=user
```

**Cara ambil user token (desktop browser):**
1. Login akun secondary di https://discord.com/app
2. F12 → Network → refresh halaman
3. Cari request ke `discord.com/api`
4. Header **Authorization** → copy value (tanpa prefix `Bearer`)

**Set token aman di VPS:**
```bash
cd /root/meridian
./scripts/set-discord-user-token.sh          # input hidden
# atau one-liner (kurang aman — masuk shell history):
./scripts/set-discord-user-token.sh '<TOKEN>'
sudo systemctl enable --now meridian-discord
```

**Risiko:** selfbot melanggar Discord ToS; pakai akun secondary, bukan main.

### Mode B — Bot token (Developer Portal)

Lebih aman ToS, butuh invite bot ke server + permission View Channel + Read Message History.

```env
DISCORD_AUTH_MODE=bot
DISCORD_BOT_TOKEN=<token_dari_developer_portal>
```

Buat di https://discord.com/developers/applications → Bot → Reset Token → invite via OAuth2 URL Generator.

---

## Env vars wajib (`.env`)

```env
DISCORD_GUILD_ID=1431687513734643904          # MeteoraIDN
DISCORD_CHANNEL_IDS=<id1>,<id2>,...            # comma-separated
DISCORD_SIGNAL_BOT_IDS=1081815963990761542    # Rick — prefer ID over nama
DISCORD_SIGNAL_BOTS=Rick                       # fallback kalau ID kosong
DISCORD_MIN_FEES_SOL=30                        # legacy doc; pre-check pakai user-config minTokenFeesSol
DISCORD_AUTH_MODE=user
DISCORD_USER_TOKEN=***
```

### Channel aktif (2026-07-03)

| Channel | ID |
|---------|-----|
| `#🏛️│LP-Alpha` | `1432714896394420357` |
| `#🚨│degen-calls` | `1433149482949677137` |
| `#⚔️│degen-dlmm` | `1432258678261547069` |
| `#🔮│midcap-dlmm` | `1432930324119294033` |
| `#🏟️│multidays-dlmm` | `1432258944700518504` |
| `#📣│announcements` | `1432254928486666330` |

### Signal bot

- **Nama:** Rick (`@Rick`)
- **User ID:** `1081815963990761542`
- Filter by ID lebih reliable daripada nama display.

Tambah channel: append ke `DISCORD_CHANNEL_IDS`, restart service.
Tambah bot: append ke `DISCORD_SIGNAL_BOT_IDS`.

---

## Operasional

```bash
# Status
systemctl status meridian-discord

# Log live
journalctl -u meridian-discord -f

# Cek startup (harus ada guild + channels + Signal bot IDs)
journalctl -u meridian-discord -n 15 --no-pager

# Cek config tanpa expose token
grep '^DISCORD_' /root/meridian/.env | sed 's/TOKEN=.*/TOKEN=***/'

# Antrian signal
cd /root/meridian && node cli.js discord-signals

# Restart setelah ubah .env
sudo systemctl restart meridian-discord
```

**Startup sukses contoh:**
```
Connected as rhoma99 (selfbot)
Watching guild: MeteoraIDN
Channels: #🏛️│LP-Alpha, #🚨│degen-calls, ...
Signal bot IDs: 1081815963990761542
```

**Pesan Rick tertangkap contoh:**
```
[message] @Rick in #⚔️│degen-dlmm: "..."
[pre-check] <mint>
  REJECT [pool] no Meteora DLMM pool found   ← normal kalau belum ada pool DLMM
```

---

## Screening integration

`user-config.json`:
```json
"useDiscordSignals": true,
"discordSignalMode": "merge"
```

- `merge` = Discord signal + discovery biasa
- `only` = cuma dari Discord

Discord **bukan auto-deploy**. Signal lolos pre-check masuk antrian; daemon tetap apply filter penuh (GMGN, indicators, cooldown, minTokenFeesSol 30, dll).

---

## Troubleshooting

| Gejala | Fix |
|--------|-----|
| `Guild not found` | Bot mode tapi bot belum di-invite → pakai user token atau invite bot |
| `Channels: #id (not found)` | Channel ID salah atau akun gak punya akses channel |
| Listener connect tapi 0 `[message]` | Bot ID salah / Rick belum post / channel salah |
| `[message]` tapi semua REJECT [pool] | Token pump.fun belum punya pool Meteora DLMM — expected |
| Token invalid / disconnect loop | Regenerate token (logout all sessions / ganti password) → `./scripts/set-discord-user-token.sh` |

---

## Security (wajib Hermes ingatkan owner)

1. **Jangan** kirim password Discord di Telegram/chat agent
2. **Jangan** commit `.env` — gitignored
3. Kalau token kebocor di chat → rotate (logout all sessions) + set ulang
4. Hermes **read-only** untuk `.env` — minta Grok/owner yang set token
5. Cek listener pakai `journalctl`, jangan paste token di log

---

## Hermes: kapan dispatch ke Grok

- Token expired / listener crash loop
- Owner mau tambah channel atau ganti signal bot
- `useDiscordSignals` perlu di-toggle
- Rick post tapi 0 address ter-extract (format embed berubah) → Grok cek parser `index.js`