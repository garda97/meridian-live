#!/usr/bin/env python3
"""
READ-ONLY Meridian position monitor.
- Hanya mengecek posisi via `node cli.js positions --source rpc --force`
- TIDAK deploy, TIDAK close, TIDAK systemctl. Murni observasi.
- Bandingkan dengan state sebelumnya, laporkan perubahan (close / OOR / nilai berubah).
"""
import json, re, subprocess, os, sys

STATE_FILE = "/tmp/meridian_pos_monitor_state.json"
CLI = "/opt/meridian/cli.js"

def get_positions():
    try:
        out = subprocess.run(
            ["node", CLI, "positions", "--source", "rpc", "--force"],
            cwd="/opt/meridian", capture_output=True, text=True, timeout=90
        ).stdout
    except Exception as e:
        return None, f"node error: {e}"
    # ambil JSON object pertama
    i = out.find("{")
    if i < 0:
        return None, "no json in output"
    try:
        d = json.loads(out[i:])
    except Exception as e:
        return None, f"json parse error: {e}"
    return d.get("positions", []), None

def load_prev():
    if os.path.exists(STATE_FILE):
        try:
            return json.load(open(STATE_FILE))
        except Exception:
            return {}
    return {}

def main():
    positions, err = get_positions()
    if positions is None:
        print(f"⚠️ MONITOR ERROR: {err}")
        return
    prev = load_prev()
    prev_map = {p["position"]: p for p in prev.get("positions", [])}

    cur_map = {p["position"]: p for p in positions}
    lines = []
    lines.append(f"📊 POSISI MERIDIAN — {len(positions)} open (read-only, no action)")
    lines.append("─" * 40)
    for p in positions:
        addr = p["position"]
        name = p.get("pair", "?")
        val = p.get("total_value_usd", 0)
        ir = "IN" if p.get("in_range") else "OUT"
        lines.append(f"  {name:14} {addr[:10]} | ${val:.2f} | {ir} range")
    lines.append("─" * 40)

    # detect changes vs prev
    changes = []
    # closed
    for addr, p in prev_map.items():
        if addr not in cur_map:
            changes.append(f"  🔴 CLOSED: {p.get('pair','?')} ({addr[:10]})")
    # new
    for addr, p in cur_map.items():
        if addr not in prev_map:
            changes.append(f"  🟢 OPENED: {p.get('pair','?')} ({addr[:10]})")
    # oor flips
    for addr, p in cur_map.items():
        if addr in prev_map:
            was = prev_map[addr].get("in_range")
            now = p.get("in_range")
            if was != now:
                flip = "→ OUT of range ⚠️" if not now else "→ back IN range ✅"
                changes.append(f"  🔄 {p.get('pair','?')} ({addr[:10]}) OOR {flip}")

    if changes:
        lines.append("PERUBAHAN:")
        lines.extend(changes)
    else:
        lines.append("Perubahan: none (stabil)")

    # save current
    json.dump({"positions": positions}, open(STATE_FILE, "w"))

    print("\n".join(lines))

if __name__ == "__main__":
    main()
