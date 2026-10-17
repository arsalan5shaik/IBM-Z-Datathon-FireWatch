"""ML-owned JSON CLI adapter. No model logic and no shell evaluation."""
import json
import subprocess
from pathlib import Path

from app.persistence.atomic import atomic_json
from app.services.time import iso


class GenerationUnavailable(Exception):
    pass


class CLIAdapter:
    def __init__(self, settings):
        self.settings = settings

    def generate(self, hours, revision, staging: Path):
        secret = self.settings.forecast_generator_cmd
        if not secret or not secret.get_secret_value():
            raise GenerationUnavailable("ML generator is not configured")
        argv = json.loads(secret.get_secret_value())
        if not isinstance(argv, list) or not argv or not all(isinstance(x,str) and x for x in argv):
            raise GenerationUnavailable("Generator command must be a JSON argv list")
        request = staging / "request.json"
        atomic_json(request, {"schema_version":"1.0", "hours":[iso(h) for h in hours],
                              "revision":revision.model_dump(mode="json"), "output_dir":str(staging)})
        try:
            subprocess.run(argv + ["--request", str(request)], cwd=self.settings.repo_root,
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                           stderr=subprocess.DEVNULL, timeout=self.settings.generator_timeout_seconds,
                           check=True, shell=False,
                           creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        except (OSError, subprocess.SubprocessError):
            raise GenerationUnavailable("ML generation failed or timed out") from None
        return {h: staging / h.strftime("%Y%m%dT%H00Z.json") for h in hours}
