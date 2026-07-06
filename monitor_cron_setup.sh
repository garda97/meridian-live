#!/bin/bash
# Meridian DLMM Position Monitor Cron Job
# Add to crontab: */5 * * * * /opt/meridian/monitor_cron_setup.sh

cd /opt/meridian || exit 1

# Run monitoring
python3 scripts/run_monitor.py >> /tmp/meridian_monitor.log 2>&1

# Keep log size manageable
if [ -f /tmp/meridian_monitor.log ]; then
    tail -1000 /tmp/meridian_monitor.log > /tmp/meridian_monitor.log.tmp
    mv /tmp/meridian_monitor.log.tmp /tmp/meridian_monitor.log
fi

exit 0
