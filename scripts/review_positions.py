import json, glob

entries = []
for f in sorted(glob.glob('logs/actions-*.jsonl')):
    with open(f) as fh:
        for line in fh:
            line = line.strip()
            if not line: continue
            try:
                e = json.loads(line)
                if isinstance(e, dict):
                    entries.append(e)
            except:
                pass

# Live deploys only
deploys = []
for e in entries:
    if e.get('tool') != 'deploy_position': continue
    r = e.get('result', {})
    if not isinstance(r, dict): continue
    if r.get('dry_run', True): continue
    pos = r.get('position_address') or r.get('position','')
    if not pos: continue
    deploys.append({
        'ts': e['timestamp'][:16],
        'pool': (e['args'].get('pool_name') or e['args'].get('pool_address','?'))[:22],
        'amount': e['args'].get('amount_y') or e['args'].get('amount_sol','?'),
        'strategy': e['args'].get('strategy','?'),
        'position': pos,
    })

# close_position
close_map = {}
for e in entries:
    if e.get('tool') != 'close_position': continue
    args = e.get('args', {})
    if not isinstance(args, dict): continue
    pos = args.get('position_address','')
    if not pos or pos in close_map: continue
    r = e.get('result', {})
    if not isinstance(r, dict): r = {}
    close_map[pos] = {
        'ts': e['timestamp'][:16],
        'pnl_usd': r.get('pnl_usd'),
        'pnl_pct': r.get('pnl_pct'),
        'fees_usd': r.get('fees_usd') or r.get('claimed_fees_usd'),
        'reason': str(args.get('reason',''))[:60],
    }

# decision-log closes
try:
    with open('decision-log.json') as f:
        dlog = json.load(f)
    decisions = dlog.get('decisions', []) if isinstance(dlog, dict) else dlog
    for d in decisions:
        if not isinstance(d, dict): continue
        if d.get('type') != 'close': continue
        pos = d.get('position','')
        if not pos or pos in close_map: continue
        m = d.get('metrics', {})
        if not isinstance(m, dict): m = {}
        close_map[pos] = {
            'ts': d['ts'][:16],
            'pnl_usd': m.get('pnl_usd'),
            'pnl_pct': m.get('pnl_pct'),
            'fees_usd': m.get('fees_usd'),
            'reason': str(d.get('reason',''))[:60],
        }
except Exception as ex:
    print(f'dlog err: {ex}')

print(f'Live deploys: {len(deploys)} | Close records: {len(close_map)}')
print()
print(f"{'#':>3} | {'Deploy':16} | {'Pool':<22} | {'SOL':>4} | {'Strat':<8} | {'Close':16} | {'PnL%':>8} | {'PnL USD':>8} | {'Fees':>7} | Reason")
print('-'*135)

wins = losses = open_pos = 0
total_pnl = 0.0
for i, d in enumerate(deploys, 1):
    c = close_map.get(d['position'], {})
    pp = c.get('pnl_pct')
    pu = c.get('pnl_usd')
    fe = c.get('fees_usd')
    ct = c.get('ts', 'OPEN')
    rs = c.get('reason', '-') if c else 'OPEN'
    ps = f"{pp:+.2f}%" if pp is not None else 'OPEN'
    us = f"{pu:+.2f}" if pu is not None else '-'
    fs = f"{fe:.3f}" if fe is not None else '-'
    if pu is not None:
        total_pnl += pu
        if pu >= 0: wins += 1
        else: losses += 1
    else:
        open_pos += 1
    print(f"{i:>3} | {d['ts']:16} | {d['pool']:<22} | {str(d['amount']):>4} | {d['strategy']:<8} | {ct:16} | {ps:>8} | {us:>8} | {fs:>7} | {rs}")

print()
total = wins + losses
wr = f"{wins/total*100:.0f}%" if total else "n/a"
print(f"Win: {wins} | Loss: {losses} | Open: {open_pos} | WinRate: {wr} | Total PnL: {total_pnl:+.2f} USD")
