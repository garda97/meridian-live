#!/bin/bash
# Meridian Monitor Cron Setup
# Install a 5-minute interval cron job for position monitoring

SCRIPT_DIR="/root/meridian/scripts"
CRON_LOG="/var/log/meridian_monitor.log"

# Make scripts executable
chmod +x "$SCRIPT_DIR/monitor_positions.py"
chmod +x "$SCRIPT_DIR/telegram_alert.py"

# Install cron job
# Run monitor every 5 minutes
CRON_CMD="*/5 * * * * cd /root/meridian && /usr/bin/python3 $SCRIPT_DIR/monitor_positions.py >> $CRON_LOG 2>&1"

# Check if already installed
if crontab -l 2>/dev/null | grep -q "monitor_positions.py"; then
    echo "✓ Cron job already installed"
else
    # Add new cron job
    (crontab -l 2>/dev/null; echo "$CRON_CMD") | crontab -
    echo "✓ Cron job installed"
fi

# Show installed cron jobs
echo ""
echo "=== Meridian Monitor Cron Schedule ==="
crontab -l | grep meridian || echo "  (no jobs found)"

echo ""
echo "Setup complete!"
echo "Log location: $CRON_LOG"
