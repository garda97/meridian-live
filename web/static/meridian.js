(function () {
  const cfg = window.MERIDIAN_CONFIG || {};
  const KEY_QUERY = cfg.keyQuery || '';

  function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function api(path) {
    return fetch(path + KEY_QUERY).then((r) => {
      if (!r.ok) throw new Error(r.status + ' ' + r.statusText);
      return r.json();
    });
  }

  function fmtTs(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
    } catch (_) {
      return iso;
    }
  }

  function statCard(label, value, extra) {
    return '<div class="stat-card"><div class="label">' + esc(label) + '</div><div class="value">' + value + (extra || '') + '</div></div>';
  }

  function renderOverview(status, config, bridge) {
    const daemon = status.daemon?.running
      ? '<span class="status-dot ok"></span>Running PID ' + esc(status.daemon.pid)
      : '<span class="status-dot off"></span>Stopped';
    const mode = status.dry_run
      ? '<span class="decision-type skip">DRY RUN</span>'
      : '<span class="decision-type deploy">LIVE</span>';

    document.getElementById('stat-grid').innerHTML = [
      statCard('Daemon', daemon),
      statCard('Mode', mode),
      statCard('Model', esc(status.model || '—')),
      statCard('Phase', esc(status.phase || '—')),
      statCard('Positions', esc(String(status.positions_tracked ?? 0)) + ' / ' + esc(String(status.risk?.max_positions ?? '—'))),
      statCard('Cycles', 'Screen ' + esc(status.intervals?.screening_min) + 'm · Mgmt ' + esc(status.intervals?.management_min) + 'm'),
    ].join('');

    const h = bridge?.latest || status.latest_handoff;
    document.getElementById('handoff-box').innerHTML = h
      ? '<div><strong>' + esc(h.from) + ' → ' + esc(h.to) + '</strong> · ' + esc(h.priority || '') + ' · ' + esc(h.status || '') + '</div>'
        + '<div style="margin-top:0.35rem">' + esc(h.summary || '') + '</div>'
        + (h.done ? '<div style="margin-top:0.35rem;color:var(--dim)">Done: ' + esc(h.done) + '</div>' : '')
      : 'No handoff data';

    const screening = config.screening || {};
    const keys = Object.keys(screening);
    document.getElementById('threshold-grid').innerHTML = keys.length
      ? keys.map((k) => '<div class="threshold-item"><div class="k">' + esc(k) + '</div><div class="v">' + esc(screening[k]) + '</div></div>').join('')
      : '<div class="pos-empty">No config</div>';
  }

  function renderWallet(walletResp) {
    const w = walletResp?.data || walletResp;
    if (!w || walletResp.error) {
      document.getElementById('wallet-box').textContent = walletResp?.error || 'Wallet unavailable';
      return;
    }
    document.getElementById('wallet-box').innerHTML = [
      '<div><strong>Address</strong><br/>' + esc(w.wallet) + '</div>',
      '<div style="margin-top:0.5rem"><strong>SOL</strong> ' + esc(w.sol) + ' ($' + esc(w.sol_usd ?? 0) + ')</div>',
      '<div><strong>Total USD</strong> $' + esc(w.total_usd ?? 0) + '</div>',
    ].join('');
  }

  function renderPositions(posResp) {
    const box = document.getElementById('positions-box');
    const cli = posResp?.cli?.data || posResp?.cli;
    const positions = cli?.positions || cli?.open_positions || [];
    if (Array.isArray(positions) && positions.length) {
      box.innerHTML = positions.map((p) => {
        const name = p.pool_name || p.name || p.symbol || 'position';
        const pnl = p.pnl_pct != null ? p.pnl_pct + '%' : (p.pnl != null ? p.pnl : '—');
        return '<div class="decision-row"><strong>' + esc(name) + '</strong>'
          + '<div class="mono" style="font-size:0.75rem;color:var(--dim);margin-top:0.2rem">' + esc(p.position || p.address || p.pool || '') + '</div>'
          + '<div style="margin-top:0.25rem">PnL: ' + esc(pnl) + '</div></div>';
      }).join('');
      return;
    }
    const statePos = posResp?.state?.positions || {};
    const entries = Object.entries(statePos);
    if (entries.length) {
      box.innerHTML = entries.map(([k, v]) => '<div class="decision-row"><strong>' + esc(k) + '</strong><pre class="log-pre" style="max-height:120px;margin-top:0.35rem">' + esc(JSON.stringify(v, null, 2)) + '</pre></div>').join('');
      return;
    }
    box.innerHTML = '<div class="pos-empty">No open positions tracked (DRY_RUN deploy may be simulated only).</div>';
  }

  function renderDecisions(data) {
    const list = data?.decisions || [];
    const box = document.getElementById('decisions-box');
    if (!list.length) {
      box.innerHTML = '<div class="pos-empty">No decisions yet.</div>';
      return;
    }
    box.innerHTML = list.map((d) => {
      const cls = (d.type || 'note').replace(/[^a-z_]/gi, '');
      const rejected = (d.rejected || []).map((r) => '<span class="rejected-chip">' + esc(r) + '</span>').join('');
      const metrics = d.metrics && Object.keys(d.metrics).length
        ? '<div style="margin-top:0.35rem;font-size:0.75rem;color:var(--dim)">' + esc(JSON.stringify(d.metrics)) + '</div>'
        : '';
      return '<div class="decision-row">'
        + '<div><span class="decision-type ' + esc(cls) + '">' + esc(d.type) + '</span> '
        + '<span style="color:var(--dim);font-size:0.75rem">' + esc(fmtTs(d.ts)) + ' · ' + esc(d.actor) + '</span></div>'
        + (d.pool_name ? '<div style="margin-top:0.35rem"><strong>' + esc(d.pool_name) + '</strong></div>' : '')
        + '<div style="margin-top:0.25rem">' + esc(d.summary || '') + '</div>'
        + (d.reason ? '<div style="margin-top:0.25rem;font-size:0.82rem;color:var(--muted)">' + esc(d.reason) + '</div>' : '')
        + (rejected ? '<div style="margin-top:0.4rem">' + rejected + '</div>' : '')
        + metrics
        + '</div>';
    }).join('');
  }

  function renderLogs(data) {
    document.getElementById('logs-box').textContent = data.lines || '(empty)';
    document.getElementById('refresh-note').textContent = data.file
      ? 'Source: ' + data.file + ' · auto-refresh 15s'
      : 'No log file found';
  }

  async function refresh() {
    try {
      const [status, config, bridge, wallet, positions, decisions, logs] = await Promise.all([
        api('/api/status'),
        api('/api/config'),
        api('/api/bridge'),
        api('/api/wallet').catch((e) => ({ error: e.message })),
        api('/api/positions').catch((e) => ({ error: e.message })),
        api('/api/decisions'),
        api('/api/logs?lines=100'),
      ]);
      renderOverview(status, config, bridge);
      renderWallet(wallet);
      renderPositions(positions);
      renderDecisions(decisions);
      renderLogs(logs);
    } catch (err) {
      console.error(err);
    }
  }

  document.querySelectorAll('.dash-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      document.querySelectorAll('.dash-nav-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.dash-view').forEach((v) => v.classList.toggle('is-active', v.id === 'view-' + view));
    });
  });

  const themeBtn = document.getElementById('theme-btn');
  if (themeBtn) {
    themeBtn.addEventListener('click', () => {
      const root = document.documentElement;
      const dark = root.classList.toggle('dark');
      root.classList.toggle('light', !dark);
      try { localStorage.setItem('meridian_theme', dark ? 'dark' : 'light'); } catch (_) {}
    });
    try {
      if (localStorage.getItem('meridian_theme') === 'light') {
        document.documentElement.classList.remove('dark');
        document.documentElement.classList.add('light');
      }
    } catch (_) {}
  }

  refresh();
  setInterval(refresh, 15000);
})();