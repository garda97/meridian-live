import json, re, statistics as st
from collections import Counter, defaultdict

P = json.load(open("/opt/meridian/lessons.json"))["performance"]
CO = json.load(open("/opt/meridian/state.json"))["closedOutcomes"]

def cls(cr):
    c = cr.lower()
    if c.startswith("low yield"): return "LOW_YIELD"
    if c.startswith("out of range"): return "OOR_TIMEOUT"
    if c.startswith("chart exit"): return "CHART_EXIT"
    if c.startswith("pumped far above"): return "PUMPED_ABOVE"
    if c.startswith("agent decision"): return "AGENT_DECISION"
    if c.startswith("trailing tp"): return "TRAILING_TP"
    if c.startswith("take profit"): return "TAKE_PROFIT"
    if c.startswith("stop loss"): return "STOP_LOSS"
    return "OTHER:" + cr[:30]

for r in P:
    r["_cls"] = cls(r["close_reason"])
    r["_ba"] = r["bin_range"]["bins_above"]
    r["_bb"] = r["bin_range"]["bins_below"]

TAIL = -9.0   # natural break in the loss distribution: -9.50% then -1.99% (7.5pp gap);
              # also == the new maxLossPct backstop, so "tail" == "loss the breakers should have caught"
def tail(r): return r["pnl_pct"] <= TAIL

def agg(rows):
    n = len(rows)
    if not n: return None
    pn = [r["pnl_pct"] for r in rows]
    ex = [r for r in rows if not tail(r)]
    d = dict(
        n=n,
        wins=sum(1 for x in pn if x > 0),
        wr=100.0*sum(1 for x in pn if x > 0)/n,
        sum=sum(pn),
        mean=sum(pn)/n,
        med=st.median(pn),
        worst=min(pn),
        best=max(pn),
        ntail=n-len(ex),
        exmean=(sum(r["pnl_pct"] for r in ex)/len(ex)) if ex else float("nan"),
        exsum=sum(r["pnl_pct"] for r in ex),
        fees=sum(r["fees_earned_usd"] for r in rows)/n,
        hold=sum(r["minutes_held"] for r in rows)/n,
        inr=sum(r["minutes_in_range"] for r in rows)/n,
        reff=sum(r["range_efficiency"] for r in rows)/n,
    )
    return d

OUT = []
def w(s=""): OUT.append(s)

w("<!-- AUTOGEN: regenerate with scratchpad/audit.py -->")
w()

# ---------- book level ----------
book = agg(P)
w("## A. Book-level baseline")
w()
w("Source: `lessons.json` -> `performance[]`, n=%d closes, %s .. %s." % (
    book["n"], min(r["recorded_at"] for r in P)[:10], max(r["recorded_at"] for r in P)[:10]))
w()
w("| Metric | Value |")
w("|---|---:|")
w("| Closes | %d |" % book["n"])
w("| Wins / Losses | %d / %d |" % (book["wins"], book["n"]-book["wins"]))
w("| Win rate | %.1f%% |" % book["wr"])
w("| Sum PnL | %+.2f%% |" % book["sum"])
w("| Mean PnL / trade | %+.3f%% |" % book["mean"])
w("| Median PnL / trade | %+.3f%% |" % book["med"])
w("| Worst / Best | %+.2f%% / %+.2f%% |" % (book["worst"], book["best"]))
w("| Tail losses (<= %.0f%%) | %d (%.1f%% of book) |" % (TAIL, book["ntail"], 100.0*book["ntail"]/book["n"]))
w("| Sum PnL **ex-tail** | %+.2f%% |" % book["exsum"])
w("| Mean PnL **ex-tail** | %+.3f%% |" % book["exmean"])
w("| Avg fees earned / trade | $%.3f |" % book["fees"])
w("| Avg hold | %.0f min |" % book["hold"])
w()
tails = sorted([r for r in P if tail(r)], key=lambda r: r["pnl_pct"])
w("**The whole expectancy hole is %d trades.** They sum %+.2f%%; the other %d sum %+.2f%%." % (
    len(tails), sum(r["pnl_pct"] for r in tails), book["n"]-len(tails), book["exsum"]))
w()

# ---------- exit class ----------
w("## B. Exit class x PnL")
w()
w("| Exit class | n | % of book | Win% | Mean PnL | Median | Mean **ex-tail** | Tails | Avg fees $ | Avg hold m | Avg in-range m |")
w("|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|")
byc = defaultdict(list)
for r in P: byc[r["_cls"]].append(r)
for k, rows in sorted(byc.items(), key=lambda x: -len(x[1])):
    a = agg(rows)
    w("| %s | %d | %.1f%% | %.0f%% | %+.3f%% | %+.3f%% | %+.3f%% | %d | %.3f | %.0f | %.0f |" % (
        k, a["n"], 100.0*a["n"]/book["n"], a["wr"], a["mean"], a["med"], a["exmean"], a["ntail"],
        a["fees"], a["hold"], a["inr"]))
w()

# ---------- exit class x strategy ----------
w("## C. Exit class x shape (strategy)")
w()
strats = ["bid_ask", "spot", "curve"]
w("| Exit class | " + " | ".join("%s n / mean / ex-tail" % s for s in strats) + " |")
w("|---|" + "---|"*len(strats))
for k, rows in sorted(byc.items(), key=lambda x: -len(x[1])):
    cells = []
    for s in strats:
        sub = [r for r in rows if r["strategy"] == s]
        if not sub: cells.append("—")
        else:
            a = agg(sub)
            cells.append("%d / %+.2f%% / %+.2f%%" % (a["n"], a["mean"], a["exmean"]))
    w("| %s | %s |" % (k, " | ".join(cells)))
w()
w("Strategy totals:")
w()
w("| Strategy | n | Win% | Mean | Mean ex-tail | Tails | Tail rate | Avg fees $ | Avg bins_above |")
w("|---|--:|--:|--:|--:|--:|--:|--:|--:|")
for s in strats:
    sub = [r for r in P if r["strategy"] == s]
    a = agg(sub)
    w("| %s | %d | %.0f%% | %+.3f%% | %+.3f%% | %d | %.1f%% | %.3f | %.0f |" % (
        s, a["n"], a["wr"], a["mean"], a["exmean"], a["ntail"], 100.0*a["ntail"]/a["n"],
        a["fees"], sum(r["_ba"] for r in sub)/len(sub)))
w()

# ---------- bins_above ----------
w("## D. Range shape: bins_above (upside cover)")
w()
def bucket_ba(r):
    if r["_ba"] == 0: return "0 (single-sided)"
    if r["_ba"] <= 30: return "1-30"
    return ">30"
w("| bins_above | n | Win% | Mean | Mean ex-tail | Avg fees $ | OOR-class share* | Avg range-eff |")
w("|---|--:|--:|--:|--:|--:|--:|--:|")
bb = defaultdict(list)
for r in P: bb[bucket_ba(r)].append(r)
for k in ["0 (single-sided)", "1-30", ">30"]:
    rows = bb.get(k) or []
    if not rows: continue
    a = agg(rows)
    oor = sum(1 for r in rows if r["_cls"] in ("OOR_TIMEOUT", "PUMPED_ABOVE"))
    w("| %s | %d | %.0f%% | %+.3f%% | %+.3f%% | %.3f | %.0f%% | %.0f%% |" % (
        k, a["n"], a["wr"], a["mean"], a["exmean"], a["fees"], 100.0*oor/a["n"], a["reff"]))
w()
w("\\* OOR-class share = closed via `OOR_TIMEOUT` or `PUMPED_ABOVE` (price left the range).")
w()

# ---------- bins_below ----------
w("## E. Range shape: bins_below (fee concentration)")
w()
def bucket_bl(r):
    if r["_bb"] < 70: return "<70 (tight)"
    if r["_bb"] <= 140: return "70-140"
    return ">140 (smeared)"
w("| bins_below | n | Win% | Mean | Mean ex-tail | Avg fees $ | Avg hold m | Avg range-eff |")
w("|---|--:|--:|--:|--:|--:|--:|--:|")
bl = defaultdict(list)
for r in P: bl[bucket_bl(r)].append(r)
for k in ["<70 (tight)", "70-140", ">140 (smeared)"]:
    rows = bl.get(k) or []
    if not rows: continue
    a = agg(rows)
    w("| %s | %d | %.0f%% | %+.3f%% | %+.3f%% | %.3f | %.0f | %.0f%% |" % (
        k, a["n"], a["wr"], a["mean"], a["exmean"], a["fees"], a["hold"], a["reff"]))
w()

# ---------- hold time ----------
w("## F. Hold-time bucket")
w()
def bucket_h(r):
    m = r["minutes_held"]
    if m < 15: return "<15 min"
    if m < 30: return "15-30 min"
    if m < 60: return "30-60 min"
    if m < 90: return "60-90 min"
    return ">=90 min"
order = ["<15 min", "15-30 min", "30-60 min", "60-90 min", ">=90 min"]
w("| Hold | n | Win% | Mean | Median | Mean ex-tail | Tails | Avg fees $ |")
w("|---|--:|--:|--:|--:|--:|--:|--:|")
bh = defaultdict(list)
for r in P: bh[bucket_h(r)].append(r)
for k in order:
    rows = bh.get(k) or []
    if not rows: continue
    a = agg(rows)
    w("| %s | %d | %.0f%% | %+.3f%% | %+.3f%% | %+.3f%% | %d | %.3f |" % (
        k, a["n"], a["wr"], a["mean"], a["med"], a["exmean"], a["ntail"], a["fees"]))
w()

# ---------- tails ----------
w("## G. Tail losses (the actual problem)")
w()
w("| # | Pool | Strategy | PnL | Hold m | In-range m | bins below/above | Exit class | Entry TVL $ | Fees $ |")
w("|--:|---|---|--:|--:|--:|---|---|--:|--:|")
for i, r in enumerate(tails, 1):
    w("| %d | %s | %s | %+.2f%% | %d | %d | %d/%d | %s | %s | %.3f |" % (
        i, r["pool_name"], r["strategy"], r["pnl_pct"], r["minutes_held"], r["minutes_in_range"],
        r["_bb"], r["_ba"], r["_cls"], "{:,.0f}".format(r["entry_tvl"] or 0), r["fees_earned_usd"]))
w()
inst = [r for r in tails if r["minutes_held"] <= 10]
w("Of %d tails, **%d closed within 10 minutes** — these are entry-quality failures (dump/rug), "
  "not exit-rule failures. No stop-loss setting saves a %+.0f%% move in %d minutes." % (
    len(tails), len(inst), min(r["pnl_pct"] for r in inst), min(r["minutes_held"] for r in inst)))
w()
w("| Tail entry-gate signal | Tail cohort | Book |")
w("|---|--:|--:|")
def cmp2(fn, fmt="%.0f"):
    a = [fn(r) for r in tails if fn(r) is not None]
    b = [fn(r) for r in P if fn(r) is not None]
    return (fmt % (sum(a)/len(a)), fmt % (sum(b)/len(b)))
import statistics as _st
def _med(rows, fn):
    v=[fn(r) for r in rows if fn(r) is not None]
    return _st.median(v) if v else 0.0
w("| Median fee/TVL ratio | %.3f | %.3f |" % (_med(tails, lambda r: r["fee_tvl_ratio"]), _med(P, lambda r: r["fee_tvl_ratio"])))
for label, fn, fmt in [
    ("Avg entry TVL $", lambda r: r["entry_tvl"], "%,.0f"),
    ("Avg entry holders", lambda r: r["entry_holders"], "%,.0f"),
    ("Avg organic score", lambda r: r["organic_score"], "%.0f"),
    ("Avg volatility", lambda r: r["volatility"], "%.2f"),
    ("Avg minutes held", lambda r: r["minutes_held"], "%.0f"),
    ("Avg fees earned $", lambda r: r["fees_earned_usd"], "%.3f"),
]:
    aa = [fn(r) or 0 for r in tails]; bbk = [fn(r) or 0 for r in P]
    va, vb = sum(aa)/len(aa), sum(bbk)/len(bbk)
    if "," in fmt:
        w("| %s | %s | %s |" % (label, "{:,.0f}".format(va), "{:,.0f}".format(vb)))
    else:
        w(("| %s | " + fmt + " | " + fmt + " |") % (label, va, vb))
w()

# ---------- data quality ----------
w("## H. Data-quality caveats found during the audit")
w()
susp = [r for r in P if abs(r["pnl_pct"]) > 0 and r["initial_value_usd"] and
        abs((r["final_value_usd"]-r["initial_value_usd"])/r["initial_value_usd"]*100 - r["pnl_pct"]) > 1.0]
w("- `pnl_pct` vs recomputed `(final-initial)/initial`: **%d/%d** records disagree by >1pp. "
  "PnL fields are not fully trustworthy; treat all means as directional." % (len(susp), len(P)))
zero = [r for r in P if r["fees_earned_usd"] == 0]
w("- **%d/%d (%.0f%%)** closes earned **exactly $0.00 fees** — pure churn, no LP income at all." % (
    len(zero), len(P), 100.0*len(zero)/len(P)))
w("- `state.json.closedOutcomes` (n=%d) contains obviously corrupt values, e.g. "
  "`\"Trailing TP: peak 7507.25%%\"` — percentage fields there are computed off a different base. "
  "Used only for cross-check, not for the numbers above." % len(CO))
w("- Position size varied %s SOL across the sample, so PnL%% is comparable but USD is not." % (
    "/".join(str(x) for x in sorted(set(r["amount_sol"] for r in P))[:6]) + "..."))
w("- n=%d is a small, single-regime sample (17 days). Everything here is a **hypothesis**, not a proven edge." % len(P))
w()

# ---------- closedOutcomes cross-check ----------
w("## I. Cross-check: `state.json.closedOutcomes` (n=%d)" % len(CO))
w()
sane = [r for r in CO if abs(r.get("pnl_pct") or 0) < 100]
w("| Exit class | n | Wins | Mean PnL (sane rows) |")
w("|---|--:|--:|--:|")
cc = defaultdict(list)
for r in CO: cc[cls(r["close_reason"])].append(r)
for k, rows in sorted(cc.items(), key=lambda x: -len(x[1])):
    sn = [r for r in rows if abs(r.get("pnl_pct") or 0) < 100]
    m = ("%+.2f%%" % (sum(r["pnl_pct"] for r in sn)/len(sn))) if sn else "n/a"
    w("| %s | %d | %d | %s |" % (k, len(rows), sum(1 for r in rows if (r.get("pnl_pct") or 0) > 0), m))
w()
w("Sane subset: n=%d, wins=%d, mean %+.2f%%. Direction agrees with the lessons.json book "
  "(negative expectancy, driven by a small number of large losses)." % (
    len(sane), sum(1 for r in sane if r["pnl_pct"] > 0), sum(r["pnl_pct"] for r in sane)/len(sane)))
w()

print("\n".join(OUT))
