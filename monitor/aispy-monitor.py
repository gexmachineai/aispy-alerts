#!/usr/bin/env python3
"""AISPYALERTS position monitor (generic, public).

While you have an open option position, this posts a small "price.tick" to YOUR
Grok Bot webhook about once a minute during US market hours. Each tick wakes
your bot, which quotes the position through YOUR broker connection (e.g.
Robinhood Agentic) and enforces the stop / trims from YOUR BOT_PROFILE.

This script never talks to a broker, never places orders, and holds no keys of
its own. Everything comes from your own setup:

  Required
    AISPY_WEBHOOK_URL       your bot's webhook URL (https://...)
    AISPY_WEBHOOK_KEY       your bot's webhook key   (or AISPY_WEBHOOK_KEY_FILE)
  Optional
    AISPY_POSITION_FILE     JSON your bot writes; ticks only while {"status":"open"}
                            (default ~/aispy-monitor/open_position.json)
    AISPY_BOT_PROFILE       path to your BOT_PROFILE file (sent with each tick)
    AISPY_INTERVAL          seconds between ticks (default 60, min 15)
    AISPY_HOME              state/log folder (default ~/aispy-monitor)

  Any of these can also live in $AISPY_HOME/config.env as KEY=value lines.

Commands:
  python3 aispy-monitor.py run      start the loop (foreground)
  python3 aispy-monitor.py arm      allow ticks
  python3 aispy-monitor.py disarm   stop ticks
  python3 aispy-monitor.py check    validate config, print it (key masked)
  python3 aispy-monitor.py once     send one test tick now (ignores hours/arming)

Not financial advice. You are responsible for your own bot and trades.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

try:
    from zoneinfo import ZoneInfo
    NY = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover
    NY = None

HOME = Path(os.environ.get("AISPY_HOME", Path.home() / "aispy-monitor")).expanduser()


def load_config() -> dict:
    cfg: dict[str, str] = {}
    f = HOME / "config.env"
    if f.exists():
        for line in f.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                cfg[k.strip()] = v.strip().strip('"').strip("'")
    for k, v in os.environ.items():
        if k.startswith("AISPY_"):
            cfg[k] = v
    key = cfg.get("AISPY_WEBHOOK_KEY", "")
    if not key and cfg.get("AISPY_WEBHOOK_KEY_FILE"):
        p = Path(cfg["AISPY_WEBHOOK_KEY_FILE"]).expanduser()
        key = p.read_text().strip() if p.exists() else ""
    return {
        "url": cfg.get("AISPY_WEBHOOK_URL", "").strip(),
        "key": key.strip(),
        "position": Path(cfg.get("AISPY_POSITION_FILE", HOME / "open_position.json")).expanduser(),
        "profile": cfg.get("AISPY_BOT_PROFILE", "").strip(),
        "interval": max(15, int(cfg.get("AISPY_INTERVAL", "60") or 60)),
    }


def log(msg: str) -> None:
    HOME.mkdir(parents=True, exist_ok=True)
    with (HOME / "monitor.log").open("a") as fh:
        fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S%z')} {msg}\n")


def validate(c: dict) -> list[str]:
    errs = []
    if not c["url"].startswith("https://"):
        errs.append("AISPY_WEBHOOK_URL missing or not https")
    if not c["key"]:
        errs.append("AISPY_WEBHOOK_KEY (or AISPY_WEBHOOK_KEY_FILE) missing")
    return errs


def market_open() -> bool:
    now = datetime.now(NY) if NY else datetime.now()
    mins = now.hour * 60 + now.minute
    return now.weekday() <= 4 and 9 * 60 + 30 <= mins < 16 * 60


def position_open(c: dict) -> bool:
    try:
        return json.loads(c["position"].read_text()).get("status") == "open"
    except Exception:
        return False


def armed() -> bool:
    return (HOME / "armed").exists()


def post_tick(c: dict, test: bool = False) -> int:
    body = {"type": "price.tick", "source": "aispy-monitor", "ts": int(time.time())}
    if c["profile"]:
        body["bot_profile"] = c["profile"]
    if test:
        body["test"] = True
    req = urllib.request.Request(
        c["url"],
        data=json.dumps(body).encode(),
        headers={
            "Authorization": f"Bearer {c['key']}",
            "X-Automation-Key": c["key"],
            "Content-Type": "application/json",
            "User-Agent": "aispy-monitor/1",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status


def run() -> None:
    c = load_config()
    errs = validate(c)
    if errs:
        sys.exit("config error: " + "; ".join(errs))
    log("monitor start")
    last_idle = 0.0
    while True:
        try:
            if armed() and market_open() and position_open(c):
                log(f"tick http={post_tick(c)}")
            elif time.time() - last_idle > 600:
                log("idle (disarmed, market closed, or no open position)")
                last_idle = time.time()
        except Exception as e:
            log(f"err {e}")
        time.sleep(c["interval"])


def main() -> None:
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    HOME.mkdir(parents=True, exist_ok=True)
    if cmd == "arm":
        (HOME / "armed").touch(); print("armed")
    elif cmd == "disarm":
        (HOME / "armed").unlink(missing_ok=True); print("disarmed")
    elif cmd == "check":
        c = load_config(); errs = validate(c)
        print(json.dumps({"webhook_url": c["url"], "key": ("set (" + str(len(c["key"])) + " chars)") if c["key"] else "MISSING",
                          "position_file": str(c["position"]), "bot_profile": c["profile"] or None,
                          "interval_s": c["interval"], "armed": armed(), "position_open": position_open(c),
                          "market_open_now": market_open(), "errors": errs}, indent=2))
        sys.exit(1 if errs else 0)
    elif cmd == "once":
        c = load_config(); errs = validate(c)
        if errs: sys.exit("config error: " + "; ".join(errs))
        print("http", post_tick(c, test=True))
    elif cmd == "run":
        run()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
