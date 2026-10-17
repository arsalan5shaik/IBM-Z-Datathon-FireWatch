"""Run one shared-cache refresh, or opt into a single independent polling owner."""

import argparse
import asyncio
import json

from app.config import Settings
from app.services.fire_cache import FireCache


async def run(settings, *, loop=False, force=False):
    cache = FireCache(settings)
    while True:
        outcome = await cache.refresh(force=force)
        status = cache.status()
        print(json.dumps({"job": "firms", "outcome": outcome, **status.model_dump(mode="json")}))
        if not loop:
            return 0 if status.status != "unavailable" else 1
        force = False
        await asyncio.sleep(settings.firms_refresh_minutes * 60)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--loop", action="store_true", help="Explicitly own FIRMS polling; run exactly one owner"
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Bypass persisted refresh interval once; never bypass locks",
    )
    args = parser.parse_args()
    try:
        return asyncio.run(run(Settings(), loop=args.loop, force=args.force))
    except KeyboardInterrupt:
        return 0
    except OSError:
        print(json.dumps({"job": "firms", "error": "cache_storage_unavailable"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
