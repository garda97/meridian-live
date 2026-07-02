#!/bin/bash
# Meridian DLMM Position Monitor Cron Job Setup
# Runs monitor.py every 5 minutes

CRON_SCRIPT="/root/meridian/scripts/run_monitor.sh"
MONITOR_PY="/root/meridian/monitor.py"

# Create scripts directory
mkdir -p /root/meridian/scripts

# Create run wrapper
cat > "$CRON_SCRIPT" << 'EOF'
#!/bin/bash
cd /root/meridian || exit 1
python3 monitor.py >> /root/meridian/monitor.log 2>&1
EOF

chmod +x "$CRON_SCRIPT"

# Add to crontab
(crontab -l 2>/dev/null | grep -v "run_monitor.sh"; echo "*/5 * * * * $CRON_SCRIPT") | crontab -

echo "✓ Monitor cron installed (every 5 minutes)"
echo "✓ Logs: /root/meridian/monitor.log"
echo "✓ Run manually: python3 /root/meridian/monitor.py"
