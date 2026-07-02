#!/bin/bash
cd /root/meridian || exit 1
python3 monitor.py >> /root/meridian/monitor.log 2>&1
