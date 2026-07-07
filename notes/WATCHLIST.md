# Meridian Watchlist — LP Army Printboard (@met_lparmy)

Auto-extracted from x-scrape of @met_lparmy (Hermes, 2026-07-07).
These are "fee-printing pools" promoted by LP Army — NOT auto-deploy targets.
They still must pass Meridian gate (organic>=70, minTvl, etc.) before any deploy.

## Top fee-printing pools (printboard, last 24h)
| # | Pool Address | Token | Note |
|---|--------------|-------|------|
| 1 | 6e7V9eegCHw997T72MxgwwJipZ6GJyZF8NvjkzT1rvpN | ANSEM-SOL | printboard #1 |
| 2 | DdZuEHGSH9LAte28K8SqeewcKQ96k6fXgj7zuWHqNWkv | MANLET-SOL | printboard #2 |
| 3 | FPPLM5Zed5A4s83djaz72yh9ACs5vCLbTp9ZD8kjtsvo | TOLY-SOL | printboard #3 |
| 4 | HEB7r3kVJLhocbWsgYSgQrTo88GRAtH29gX1ev3Cd9hX | ZERO-SOL | printboard #4 |
| 5 | 4XXh2q71SaE9nPXyKQ9Ad6tFymXsu1cqg6N33WNuNxnR | ACM-SOL | printboard #5 (rug-mentioned in Recovery Strat tweet) |

## Other LP Army featured pools
| Pool Address | Token | Source |
|--------------|-------|--------|
| AUvX4hEMi9t43aqovA5tEAA5AZ7yugcpHa8SkJVEoEKa | ANSEM-SOL | alt printboard |
| J4cGfY61ZMaBD2niXcfaUD7KsNZiDnjMnJsPJficos8J | ANSEM-SOL | alt printboard |
| 6gTP8TitYMf4sQeeACfB4YaSbqMYmsgXt3gZez4NjFn4 | MANLET-SOL | alt printboard |
| xx3geLdL3ZPHpTwHYY61G4TFoAvf1rrGvEt6u9CiSbS | ? | printboard |
| HD6Poyu5CCS2oWV6kCKxJp9jow1CDQAx5mvHd7MHoEY2 | ? | printboard |
| sz2UJhf8KWxa115KmwcDuJYnUZx1fxDBetcAxXSboKi | ? | printboard |
| 8mMUyiiHahLBnPeSPQ1aLzudh5CKJnae6m66nGgGKpUp | ? | printboard |

## Strategy note (Recovery Strat — @Heavymetalcook6 via @met_lparmy)
When upper position goes OOR (token drops/rugs): open a RECOVERY position
lower (bid-ask down), compound fees from lower into upper. See scripts/recovery_manager.py.

## How to use
- These are watchlist ONLY. Daemon will NOT auto-deploy to them.
- To evaluate: `node cli.js pool-detail --pool <ADDRESS>` then check gate.
- If passes gate + bro approves, daemon may deploy on next screening cycle.
