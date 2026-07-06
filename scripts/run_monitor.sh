#!/bin/bash
cd /opt/meridian || exit 1
python3 monitor.py >> /opt/meridian/monitor.log 2>&1
