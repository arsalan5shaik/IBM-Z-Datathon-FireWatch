# LightGBM historical data status

## Ready locally

- The provided seven-day 2024 ERC pilot matches gridMET ERC-G at its recorded native source coordinates: **323,386 valid labels checked, zero mismatches**. The source variable is `energy_release_component-g`, unitless, with ERC-G based on fuel model G.
- California-bounded historical gridMET subsets now cover ERC labels **2024-01-01–2025-12-31**, with the required **2023-12-31** weather warm-up. The one-day NCSS probe returned the expected 2024-07-20 value, date, and unit before bulk extraction.
- Weather file: **35,149,908 rows**, 48,019 numeric cells per date across 732 source dates. ERC file: **34,563,873 labeled rows**, 47,283 cells per date across 731 dates. **538,016** missing ERC cell-days are omitted. All output hashes and detailed range/coverage checks are in `data/gridmet_historical/gridmet_training_inputs_manifest.json`; the short review is `data/gridmet_historical/quality_report.md`.
- The bounded native subsets totaled **504,935,556 bytes (~505 MB)**. The final corrected pass took about 27 minutes with already-fetched 2023 and 2024 subsets reused from cache. Output gzip files total about 373 MB.
- `data/input/grid_id_mapping.csv` maps all **48,019** numeric IDs to the `ca_3km_3310_v1` column/row namespace. Polygon-derived EPSG:3310 indices agree with all **46,200** nonblank numeric IDs in the supplied verified ERC crosswalk; 44 source rows without numeric IDs remain unmapped. The 1,819 cells without pilot source coordinates use geometry-derived lattice centers and nearest native gridMET pixels.
- Elevation file and grid IDs match one-to-one. Its 75 unavailable min/max pairs remain NaN, with zero and negative elevations preserved. No historical vegetation series was available, so the configured model proceeds without vegetation.
- Nine pipeline contract tests pass. A seven-day local prepare check also confirmed the weather lag, schema, and missing-elevation handling.

## Training handoff

Full streaming preparation is complete at `artifacts/prepared_2024_2025/`. It contains 34,563,873 real labeled rows across 47,283 ERC-covered cells and 731 dates. The chronological tables contain 17,305,578 train rows (2024), 8,558,223 validation rows (January-June 2025), and 8,700,072 test rows (July-December 2025). See `artifacts/prepared_2024_2025/data_quality_report.md` for feature nulls, hashes, sizes, and coverage. The Windows host had about 0.39 GiB free RAM at launch, so preparation streamed daily and peaked near 0.17 GiB.

The remote fit has not been run: this checkout has no LinuxONE SSH host or credentials. Transfer the three prepared gzip tables, schema, pipeline/spatial/predict scripts, config, and verified ID mapping using WinSCP; run the `train-partitioned` command in `README.md` from `/home/linux1/firewatch` after activating the existing `~/firewatch-ml-venv`.

The five 2023-12-31 source cells where maximum temperature is 0.30–0.40 °C below minimum are documented and preserved as provider values; no correction was fabricated. They are weather warm-up inputs for the first 2024 target day.

The model target is historical daily ERC environmental danger, not ignition probability. Future daily predictions require corresponding forecast-weather inputs; historical observed weather is not a current forecast. No elevation extraction, terrain download, grid regeneration, synthetic labels, or XGBoost code changes were performed.
