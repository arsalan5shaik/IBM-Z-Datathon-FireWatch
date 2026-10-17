#!/usr/bin/env python3
"""Download the two official CA boundary archives only; never weather/elevation.

No GIS dependencies. Cached files are checked against the saved SHA-256 manifest.
"""
import argparse
import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from zipfile import ZipFile

from fetch_weather_elevation import retry_wait

ROOT = Path(__file__).resolve().parents[1]
CATALOG = "https://data.ca.gov/dataset/ca-geographic-boundaries"
BASE = "https://publish.data.ca.gov/dataset/e212e397-1277-4df3-8c22-40721b095f33/resource/"
RESOURCES = {
    "state": BASE + "3db1e426-fb51-44f5-82d5-a54d7c6e188b/download/ca_state.zip",
    "counties": BASE + "b0007416-a325-4777-9295-368ea6b710e6/download/ca_counties.zip",
}


def download(url):
    for attempt in range(4):
        try:
            request = Request(url, headers={"User-Agent": "FireWatch-boundary-pilot/1", "Cache-Control": "no-cache"})
            with urlopen(request, timeout=90) as response:
                content = response.read(20_000_001)
            if len(content) > 20_000_000:
                raise ValueError("Boundary archive exceeds 20 MB safety limit")
            return content
        except HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise RuntimeError(f"Boundary request failed: HTTP {exc.code}") from exc
            time.sleep(retry_wait(exc.headers.get("Retry-After"), attempt))
        except (URLError, TimeoutError) as exc:
            if attempt == 3:
                raise RuntimeError("Boundary network request failed") from exc
            time.sleep(2 ** (attempt + 1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=ROOT / "data/raw/ca_boundaries")
    parser.add_argument("--download", action="store_true", help="Retrieve two archives; otherwise dry run")
    args = parser.parse_args()
    if not args.download:
        print(json.dumps({"catalog": CATALOG, "resources": RESOURCES, "estimated_total_mb": 2.7}, indent=2))
        return
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    locked = json.loads((ROOT / "docs/BOUNDARY_SOURCES.json").read_text(encoding="utf-8"))
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        "catalog_url": CATALOG,
        "boundary_vintage": "2023 MAF/TIGER; governmental boundaries effective 2023-01-01 per catalog",
        "rights": "No Restrictions on Public Use (catalog)", "resources": {},
    }
    for name, url in RESOURCES.items():
        path = args.out / f"{name}.zip"
        if path.exists():
            entry = manifest["resources"].get(name)
            if entry is None or hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"] or entry["sha256"] != locked["resources"][name]["sha256"]:
                raise ValueError(f"Untracked or changed archive: {path}; review before replacing")
            print(f"Cached: {path}")
            continue
        content = download(url)
        if hashlib.sha256(content).hexdigest() != locked["resources"][name]["sha256"]:
            raise ValueError(f"Official {name} archive changed; review the source lock and grid version before accepting new geometry")
        temp = path.with_suffix(".tmp")
        temp.write_bytes(content)
        with ZipFile(temp) as archive:
            if archive.testzip() is not None:
                raise ValueError("Corrupt boundary archive")
            suffixes = {Path(n).suffix.lower() for n in archive.namelist()}
            if not {".shp", ".shx", ".dbf", ".prj"}.issubset(suffixes):
                raise ValueError("Boundary archive lacks required shapefile components")
        temp.replace(path)
        manifest["resources"][name] = {
            "url": url, "sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content),
            "retrieved_at_utc": datetime.now(timezone.utc).isoformat(), "file": path.name,
        }
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        print(f"Saved {path}: {len(content):,} bytes")
        time.sleep(1)


if __name__ == "__main__":
    main()
