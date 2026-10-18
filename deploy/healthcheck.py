"""Container liveness checks; provider availability is reported separately."""

import os
import sys
import time
import urllib.request
from pathlib import Path

if sys.argv[1] == "api":
    with urllib.request.urlopen("http://127.0.0.1:8000/health/ready", timeout=3) as response:
        if response.status != 200:
            raise SystemExit(1)
else:
    heartbeat = Path("/tmp/firms-heartbeat")
    maximum_age = int(os.environ.get("FIRMS_REFRESH_MINUTES", "15")) * 60 + 120
    if time.time() - heartbeat.stat().st_mtime > maximum_age:
        raise SystemExit(1)
