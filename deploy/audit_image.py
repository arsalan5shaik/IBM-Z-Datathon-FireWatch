"""Check every saved runtime-image layer for local data and an optional secret canary."""

import argparse
import json
import subprocess
import tarfile
import tempfile
from pathlib import Path, PurePosixPath


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--canary", help="Non-secret marker used in excluded local dotenv files")
    args = parser.parse_args()
    info = json.loads(subprocess.check_output(["docker", "image", "inspect", args.image]))[0]
    assert info["Config"]["User"] in ("10001:10001", "101:101")
    for entry in info["Config"]["Env"]:
        name, _, value = entry.partition("=")
        if name in ("OPENAI_API_KEY", "NASA_FIRMS_MAP_KEY", "CHAT_PROXY_TOKEN", "LLM_API_KEY"):
            assert not value, f"Embedded credential variable: {name}"
    checked = 0
    with tempfile.TemporaryDirectory(prefix="firewatch-layer-audit-") as directory:
        archive = Path(directory) / "image.tar"
        subprocess.run(["docker", "image", "save", "-o", str(archive), args.image], check=True)
        with tarfile.open(archive) as saved:
            manifest = json.load(saved.extractfile("manifest.json"))
            for layer in manifest[0]["Layers"]:
                with tarfile.open(fileobj=saved.extractfile(layer), mode="r|*") as contents:
                    for member in contents:
                        path = PurePosixPath(member.name)
                        assert not any(
                            part == ".env"
                            or part.startswith(".env.")
                            or part in (".venv", "node_modules", "provider-cache")
                            for part in path.parts
                        ), member.name
                        assert not path.name.endswith((".sqlite", ".sqlite3")), member.name
                        if args.canary and member.isfile():
                            data = contents.extractfile(member)
                            previous = b""
                            while chunk := data.read(1024 * 1024):
                                block = previous + chunk
                                assert args.canary.encode() not in block, member.name
                                previous = block[-len(args.canary) :]
                checked += 1
    print(
        json.dumps(
            {
                "result": "PASS",
                "image": args.image,
                "architecture": info["Architecture"],
                "layers_checked": checked,
                "canary_checked": bool(args.canary),
            }
        )
    )


if __name__ == "__main__":
    main()
