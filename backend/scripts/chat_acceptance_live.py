"""Opt-in PAID chatbot acceptance against scripts/live_verification_server.py.

Never run in CI. Requires FIREWATCH_RUN_PAID_VERIFICATION=1 and the same
FIREWATCH_VERIFY_SESSION as the server, whose ledger enforces approved caps.
Pass question numbers to run a subset, e.g. `python scripts/chat_acceptance_live.py 1 3`.
Automated checks are screening only; every answer still needs human review.
"""

import json
import os
import re
import sys
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from time import perf_counter

import httpx

API = "http://127.0.0.1:8007/api/v1/chat"
STOCKTON, SACRAMENTO = "place-ca-stockton", "place-ca-sacramento"

# (question, location, expected modes, must match, must not match)
QUESTIONS = [
    (
        "What does fire radiative power mean?",
        None,
        {"reference", "openai"},
        [r"megawatts|\bMW\b", r"not acreage|not .*burned area"],
        [r"probability that"],
    ),
    (
        "How does wind affect wildfire spread?",
        None,
        {"openai"},
        [r"wind", r"spread"],
        [r"\b\d+(?:\.\d+)? ?(?:km/h|mph)\b.*(?:today|tomorrow|now)"],
    ),
    (
        "What is the difference between a satellite hotspot and a confirmed wildfire?",
        None,
        {"reference", "openai"},
        [r"not a confirmed wildfire|not .*confirm", r"official"],
        [],
    ),
    (
        "What does nominal confidence mean for this VIIRS detection?",
        None,
        {"reference", "openai"},
        [r"nominal \(n\)|nominal", r"not (?:mean )?low|does not mean low"],
        [r"low/nominal", r"\d+ ?% (?:chance|probability)"],
    ),
    (
        "Where can I find official California wildfire incident updates?",
        None,
        {"openai"},
        [r"ca\.gov|CAL FIRE|fire\.ca\.gov"],
        [],
    ),
    (
        "How should I prepare for wildfire evacuation?",
        STOCKTON,
        {"openai"},
        [r"go bag|emergency kit|plan|supplies"],
        [r"evacuation order (?:is|has been) (?:issued|in effect)"],
    ),
    (
        "What should I do if I receive an evacuation order?",
        None,
        {"openai"},
        [r"leave|follow|official"],
        [r"evacuation order (?:is|has been) (?:issued|in effect)"],
    ),
    (
        "What are the latest detections near Sacramento?",
        SACRAMENTO,
        {"openai"},
        [r"detect|hotspot", r"UTC|acquired|observ"],
        [r"confirmed (?:wild)?fire (?:is|was)"],
    ),
    (
        "What is Stockton's risk over the next seven days?",
        STOCKTON,
        {"data_unavailable"},
        [r"unavailable"],
        [r"(?:high|low|elevated|moderate) risk(?! level)"],
    ),
    (
        "Why is wildfire risk elevated in Stockton?",
        STOCKTON,
        {"data_unavailable"},
        [r"unavailable", r"SHAP"],
        [r"because|due to"],
    ),
    (
        "What do the confidence values of the latest satellite detections near Sacramento mean?",
        SACRAMENTO,
        {"openai"},
        [r"nominal|low|high|no (?:satellite )?detections"],
        [r"low/nominal"],
    ),
    (
        "Are there evacuation orders in Stockton right now?",
        STOCKTON,
        {"openai", "data_unavailable"},
        [r"cannot verify current evacuation orders", r"911"],
        [],
    ),
]


def main():
    if os.environ.get("FIREWATCH_RUN_PAID_VERIFICATION") != "1":
        raise SystemExit("Explicit FIREWATCH_RUN_PAID_VERIFICATION=1 required")
    session = os.environ.get("FIREWATCH_VERIFY_SESSION", "")
    if Path(session).name != session or not session.startswith("firewatch-"):
        raise SystemExit("Use the verification server's firewatch- session name")
    selected = [int(arg) for arg in sys.argv[1:]] or range(1, len(QUESTIONS) + 1)
    path = Path(tempfile.gettempdir()) / session / "answers.json"
    results = json.loads(path.read_text()) if path.exists() else []
    with httpx.Client(timeout=100) as client:
        for number in selected:
            question, location, modes, must, must_not = QUESTIONS[number - 1]
            hour = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
            body = {"message": question, "location_id": location, "selected_hour": hour.isoformat()}
            started = perf_counter()
            response = client.post(API, json=body)
            seconds = round(perf_counter() - started, 3)
            data = response.json()
            row = {
                "number": number,
                "question": question,
                "location_id": location,
                "http_status": response.status_code,
                "seconds": seconds,
            }
            if response.status_code == 200:
                text = data["answer"]
                failures = [p for p in must if not re.search(p, text, re.I)] + [
                    "forbidden:" + p for p in must_not if re.search(p, text, re.I)
                ]
                if data["mode"] not in modes:
                    failures.append(f"mode:{data['mode']}")
                row.update(
                    mode=data["mode"],
                    model=data["model"],
                    tools_used=data["tools_used"],
                    sources=[
                        {"kind": s["kind"], "title": s["title"], "url": s.get("url")}
                        for s in data["sources"]
                    ],
                    limitations=data["limitations"],
                    answer=text,
                    screening="PASS" if not failures else "REVIEW",
                    screening_failures=failures,
                )
            else:
                row.update(error=data.get("error", data), screening="FAIL")
            results.append(row)
            path.write_text(json.dumps(results, indent=2))
            print(
                json.dumps(
                    {
                        k: row.get(k)
                        for k in (
                            "number",
                            "http_status",
                            "seconds",
                            "mode",
                            "tools_used",
                            "screening",
                            "screening_failures",
                        )
                    }
                ),
                flush=True,
            )


if __name__ == "__main__":
    main()
