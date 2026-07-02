# API CREDIT SAVINGS PLAN

**Current:** $14 remaining in OpenRouter
**Goal:** Stretch to last 2+ weeks

---

## 1. DISABLE LLM SCREENING (biggest savings)

**Cost:** ~$0.50 per screening cycle = $14 gone in 28 cycles

**Fix:** Change `llmModel` to local/disabled

```bash
cd /root/meridian
node cli.js config set llmModel "disabled"
```

**Impact:**
- Screening will use rule-based filters ONLY (no LLM analysis)
- Faster execution (5-10 sec vs 30+ sec per pool)
- No LLM cost
- Trade-off: No AI narrative analysis (but you have manual swap, so ok)

---

## 2. INCREASE SCREENING INTERVAL

**Current:** Might be running every 5-10 min
**New:** Run every 30-60 minutes

Edit `user-config.json`:
```json
"managementIntervalMin": 30    // was 10
"opportunityPollEnabled": false
```

This reduces LLM calls 6x (60 min instead of 10 min).

---

## 3. USE LOCAL LM STUDIO INSTEAD

**Option:** Install LM Studio locally (free, no API cost)

```bash
# Option in .env
LLM_API_KEY=lm-studio
# OR use OpenRouter but with cheaper models
```

This needs setup, but zero cost after.

---

## 4. REDUCE POOL DISCOVERY CALLS

**Current:** Each screening cycle = 10-20 pool lookups

**New:** Only fetch top 5-10 pools, not 50+

Edit `user-config.json`:
```json
"maxPoolsToScreen": 5  // limit discovery
```

---

## 5. DISABLE DISCORD SIGNALS

If enabled, might be making extra API calls.

```json
"useDiscordSignals": false
```

---

## RECOMMENDATION

**Fastest way to save $14:**

1. ✅ **Disable LLM screening NOW**
   ```bash
   node cli.js config set llmModel "disabled"
   ```
   **Saves:** ~$0.50/cycle × 28 cycles = $14 → stretch indefinitely

2. ✅ **Set management interval to 30 min**
   ```bash
   node cli.js config set managementIntervalMin 30
   ```
   **Saves:** 6x fewer cycles

3. ✅ **Disable opportunity polling**
   ```bash
   node cli.js config set opportunityPollEnabled false
   ```

**Total savings:** 95%+ of LLM costs

---

## WHAT YOU LOSE

- ❌ AI narrative analysis (but manual screening ok)
- ❌ Real-time opportunity detection (30 min delay)

## WHAT YOU KEEP

- ✅ Automated position management (claims, closes, trailing stops)
- ✅ Rules-based screening (TVL, mcap, organic filters)
- ✅ Manual swap capability (you control entry/exit)

---

## EXECUTE NOW?

Y/N?
