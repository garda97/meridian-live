
## 2026-07-07 08:11 — Screening Analytics (50 pools scanned)
Live pools fetched: 50 (bin_step=1, 30m)

### CURRENT (strict)
  Passed: 11/50
  Est. trade opportunities/scan: 11
  If maxPositions=6, turnover 2.4h: ~12/day potential

### A1 loosen tvl->300K
  Passed: 15/50
  Est. trade opportunities/scan: 15
  If maxPositions=6, turnover 2.4h: ~16/day potential

### A2 loosen vol->2K
  Passed: 11/50
  Est. trade opportunities/scan: 11
  If maxPositions=6, turnover 2.4h: ~12/day potential

### A3 both (aggressive)
  Passed: 20/50
  Est. trade opportunities/scan: 20
  If maxPositions=6, turnover 2.4h: ~21/day potential

### Reject reasons (CURRENT gate)
  - tvl 0K: 17
  - tvl 4432K: 1
  - tvl 1710K: 1
  - tvl 591K: 1
  - tvl 3490K: 1
  - tvl 5719K: 1
  - tvl 334K: 1
  - tvl 235K: 1
  - tvl 234K: 1
  - tvl 230K: 1
  - tvl 2846K: 1
  - tvl 179K: 1
  - tvl 16K: 1
  - tvl 3418K: 1
  - tvl 15327K: 1
  - tvl 2918K: 1
  - tvl 421K: 1
  - tvl 308K: 1
  - tvl 423K: 1
  - tvl 29447K: 1
  - tvl 935K: 1
  - tvl 1166K: 1
  - tvl 2102K: 1

> Note: mcap/organic_score require GMGN/rugcheck enrichment (not in discovery API).
> This analytics uses TVL/volume/APR proxies. For true minOrganic simulation,
> run with enriched data or loosen screening.minOrganic in config.

Scanned at: 2026-07-07T08:11:18.066967
