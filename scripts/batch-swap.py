#!/usr/bin/env python3
"""Delegates to auto-swap-dust.js (Jupiter Swap API v2)."""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cmd = ["node", os.path.join(ROOT, "scripts", "auto-swap-dust.js"), *sys.argv[1:]]
sys.exit(subprocess.call(cmd, cwd=ROOT))