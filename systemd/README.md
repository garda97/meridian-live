# systemd units

This host has `crond` installed but disabled and inactive, and schedules work
through systemd timers instead. A crontab entry here looks scheduled and never
fires — check `systemctl list-timers` rather than `crontab -l` when wondering
whether something runs.

## gmgn-ban-watcher

Probes the GMGN API for recovery after a ban and clears
`notes/_gmgn_ban_state.json`. `tools/gmgn.js` sets that state the moment the API
reports a ban; the watcher exits immediately while no ban is recorded, because
its probe spends the same daily GMGN quota the bot does.

Runs as root: `/opt/meridian/.env` is `root:root 0600` and the GMGN key inside
is envrypt-encrypted, so the script needs the daemon's own loader.

    sudo cp systemd/gmgn-ban-watcher.* /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now gmgn-ban-watcher.timer

    systemctl list-timers gmgn-ban-watcher.timer
    tail -f logs/gmgn-ban-watcher.log
