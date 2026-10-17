# GitHub handoff

This project directory is a source folder without its own `.git` checkout.
Do not stage its contents through an unrelated ancestor/home-directory repository.
Use a clone of the team's real repository and review changes on a feature branch.
No commit, push, remote change, project Git initialization or staging was performed
during this preparation.

## Exact source manifest: 22 files

```text
.gitattributes
.gitignore
AGENTS.md
README.md
requirements-gis.txt
data/sample_california_cells.csv
docs/BOUNDARY_SOURCES.json
docs/DATA_CONTRACT.md
docs/EXTRACTION_PIPELINE.md
docs/GITHUB_HANDOFF.md
docs/GRID_DECISION.md
docs/GRID_PILOT.md
prompts/CODEX_TASKS.md
scripts/build_prediction_grid.py
scripts/download_ca_boundaries.py
scripts/estimate_grid.py
scripts/extract_statewide_features.py
scripts/fetch_weather_elevation.py
scripts/inspect_archived_7day_forecast.py
tests/test_extraction.py
tests/test_grid.py
tests/test_pipeline.py
```

All six scripts, all three test files, all documentation, the optional GIS
dependency pins and the five-row city sample belong in Git. The sample is an
explicit `.gitignore` exception; it is not a downloaded dataset. The boundary
source JSON records public URLs/checksums, not downloaded geometry or secrets.
No runtime dependency file is needed: collection/CSV processing use the standard
library, and ML dependencies are managed separately by the team.

The local `output/github-ready/` export contains copies of exactly these files,
with the same relative layout. It contains no environment, generated datasets,
credentials or Git metadata. It is an ignored handoff artifact, not another
project to commit alongside the original. Git attributes normalize shared text
files to LF for cross-platform use.

## Keep out of the commit

- `.venv-gis/`, other virtual environments, Python/tool caches and editor settings.
- `data/raw/`: official boundary archives and their generated retrieval manifest.
- `data/processed/`: statewide and Fresno CSVs, GeoJSONs, generated metadata and
  anchor mappings. Reproduce with the README commands, or transfer separately.
- `output/`: pilot weather/elevation, API responses, usage ledger, checkpoints,
  validation reports, projections, run history and the clean source export.
- Temporary/incomplete files, archives, databases, trained model binaries, local
  credentials, environment files and private keys.

The ignore rules also protect CSV/GeoJSON output written outside the default
directories. Future intentionally small fixtures need an explicit exception and
review. These rules do not remove files already tracked in a team repository;
inspect its staged list before committing. Never use `git add -f` for datasets.
Ignored files remain on disk when VS Code closes, but Git does not back them up.

## Validation and sharing checks

Run from this pipeline's directory:

```text
python -m unittest discover -s tests -v
.venv-gis/Scripts/python.exe -m unittest discover -s tests -v
```

Use `python3` on LinuxONE and `.venv-gis/bin/python` for an optional Unix GIS
environment. The existing suite has 28 tests: all run in the GIS environment;
seven GIS tests skip in the standard-library-only environment. No live API calls,
package installation or geographic regeneration is required for these checks.

The source review checks credentials/private-key markers, authenticated URLs,
machine-specific Windows/Unix home paths, unexpectedly large files and local
Markdown links. A disposable local Git repository verifies ignore behavior and
the untracked source manifest without touching this project's Git state. No
external secret-scanning service or new package is used. Review the actual diff
again in the destination repository; that repository may have its own hooks,
ignore patterns or existing files. There is no project index/history here to
audit for previously committed secrets.

Preparation results on 2026-10-17: **28 tests passed, zero failed** in the GIS
environment. A second run inside the source-only export passed 21 tests and
skipped the seven optional geometry tests, with zero failures. No generated
datasets were included in that export. All 32 representative ignore cases passed;
all 22 intended files remained visible to Git. The source pattern scan found no
credentials/private-key markers or machine-specific absolute paths, and all local
Markdown links resolved. A staging dry run succeeded only in the disposable test
repository; this source folder and the team repository were not staged or changed
through Git. Results are also recorded locally in `output/github_review.json`.

## Recommended feature-branch commands

To preserve teammates' root README, instructions and ignore rules, the default
handoff places this project in a dedicated **data-pipeline/** subdirectory.
Replace `TEAM_REPOSITORY_URL` with the team's real repository URL; do not put an
access token in that URL. Use your team's existing authenticated Git setup.
Replace the example branch name if a different feature branch is required.

From the current source folder in Windows PowerShell, after preparation:

```powershell
$pipelineSource = (Resolve-Path ./output/github-ready).Path
git clone TEAM_REPOSITORY_URL firewatch-team
Set-Location ./firewatch-team
git switch -c feature/firewatch-data-pipeline
if (Test-Path ./data-pipeline) { throw 'data-pipeline already exists; review and merge the source files deliberately.' }
Copy-Item -LiteralPath $pipelineSource -Destination ./data-pipeline -Recurse
git add -- data-pipeline
git diff --cached --check
git diff --cached --stat
git diff --cached
git status --short
```

Inspect the staged list: it should contain only the 22 paths above, prefixed with
`data-pipeline/`. Confirm any destination-specific root ignore rules did not hide
required files. After reviewing the staged diff, run these commands yourself:

```bash
git commit -m "Add FireWatch California data pipeline"
git push -u origin feature/firewatch-data-pipeline
```

If you already have a team clone, skip cloning, change into that clone and create
or switch to your actual feature branch before copying. If the branch exists,
use `git switch feature/firewatch-data-pipeline` instead of `git switch -c`.
If your team wants files at repository root instead, merge the root documentation,
instructions and ignore rules deliberately; do not overwrite them with a folder
copy. No force push or automatic remote changes are needed.

The official geographic contract remains 48,019 cells, 4,472 weather anchors,
3 km resolution, EPSG:3310, origin `(0,0)` and permanent grid version
`ca_3km_3310_v1`. Full CSV/GeoJSON reproduction is documented in README.md; these
generated artifacts are intentionally absent from the source commit.
