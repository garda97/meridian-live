#!/usr/bin/env python3
"""
Meridian Evil Panda Video Analysis Pipeline (Hermes, 2026-07-07)
Replaces dead cron job 0309f562d66c.

Downloads Evil Panda / KOL strategy videos referenced in Meridian X scrape,
extracts audio (mp3) via ffmpeg, and archives them under notes/video-analysis/
for owner/Claude review. Does NOT auto-deploy or trade.

Layer 1 (preferred) of meridian-lp-strategy skill: the companion text thread
is usually more useful than the video. This script archives both the video
and a metadata note pointing to the source thread.

Usage: python3 scripts/video_analysis_pipeline.py [video_url]
If no URL given, falls back to the hardcoded Evil Panda bootcamp video
referenced in the original cron job.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "notes" / "video-analysis"
OUT.mkdir(parents=True, exist_ok=True)

DEFAULT_VIDEO_URL = "https://video.twimg.com/amplify_video/2073960817918386177/vid/avc1/1920x1080/pl.m3u8"

def run(cmd, timeout=120):
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
        return r.returncode == 0, r.stdout + r.stderr
    except Exception as e:
        return False, str(e)

def main():
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_VIDEO_URL
    ts = time.strftime("%Y%m%d-%H%M%S")
    print(f"[{ts}] Video pipeline: {url}")
    stem = f"evilpanda-{ts}"
    mp4 = OUT / f"{stem}.mp4"
    mp3 = OUT / f"{stem}.mp3"

    # 1. Download video (ffmpeg handles m3u8/HLS)
    ok, out = run(f'ffmpeg -y -i "{url}" -c copy "{mp4}" 2>&1', timeout=180)
    if not ok:
        print(f"  [video] download failed (URL may be expired 404): {out[-200:]}")
        # remove the empty/garbage mp4 so we don't archive a dead file
        if mp4.exists() and mp4.stat().st_size == 0:
            mp4.unlink()
        # try curl fallback
        ok2, out2 = run(f'curl -L -o "{mp4}" "{url}" 2>&1', timeout=180)
        if not ok2:
            print(f"  [video] curl fallback also failed: {out2[-200:]}")
            print("  [skip] no valid video fetched this run — will retry next cycle")
            return
    print(f"  [video] saved: {mp4}")

    # 2. Extract audio
    ok, out = run(f'ffmpeg -y -i "{mp4}" -vn -acodec libmp3lame -q:a 4 "{mp3}" 2>&1', timeout=120)
    if ok:
        print(f"  [audio] saved: {mp3}")
    else:
        print(f"  [audio] extract failed: {out[-200:]}")

    # 3. Metadata note (Layer 1 hint: find companion thread via X)
    note = OUT / f"{stem}.txt"
    note.write_text(
        f"Evil Panda video archived {ts}\n"
        f"source_url: {url}\n"
        f"video: {mp4.name}\n"
        f"audio: {mp3.name}\n\n"
        f"Layer-1 analysis (preferred, no whisper needed):\n"
        f"  Search companion thread on X via GETXAPI:\n"
        f"  from:bengsharksol \"Evil Panda\" OR DLMM OR Meteora -filter:replies\n"
        f"  Also check @narkokek, @MeteoraCIS, @tendorian9 for breakdowns.\n"
        f"  Then patch concrete params (Supertrend/RSI(2)/BB/MACD) into notes/METEORA_LP.md\n"
    )
    print(f"  [note]  saved: {note}")

    # 4. (Optional) if GETXAPI key present, fetch the source thread text
    key_path = Path.home() / ".meridian" / "secrets" / "getxapi.key"
    if key_path.exists():
        print("  [x] GETXAPI key found — manual thread fetch available via get_tweet_detail")
    else:
        print("  [x] GETXAPI key not present for thread resolution (video archived only)")

if __name__ == "__main__":
    main()
