# Usage dashboard and collection status validation

Validated 2026-10-08 against the candidate based on `80379e160b61bc5672eed21d439f09d332d0fea9`.

- 52 verification scripts passed; TypeScript and ESLint exited 0. Tests used disposable MongoDB databases on loopback port 27398, never the deployment database.
- The candidate Docker image built successfully with the repository Dockerfile. The uploader archive is packaged into the image.
- Collection overview validation uses the actual HTTP response, verifies member-only access, distinguishes unknown counters from zero, keeps one source record across duplicate device receipts, and does not treat a device heartbeat as a tool record receipt.
- Existing usage reports: 40 assertions passed. Existing observation rendering: 6 checks passed. Forest, people view, request basis, total series, and price conversion suites also passed.
- Previous collection browser gate: 1360/390px, five tool details, keyboard open/close, error removes previous numbers, retry recovers, one status request on initial load.
- Record ingestion remains opt-in for installed uploaders. This release does not enable reviewed record cutover scopes, reinstall local collectors, backfill production records, or claim globally complete collection.
- Experiments remain controlled by `TOKEN_FOREST_EXPERIMENTS_MODE` (default `off`).

## Reproduction

Run `src/scripts/verify-*` and `packages/uploader/src/scripts/verify-*` with the disposable database guards specified by each script. HTTP checks need a local application with cron disabled. The collection overview script requires `MONGODB_URI=mongodb://127.0.0.1:27398/tf-v2-test-collection-preview` and localhost port 4812. Experiment HTTP verification expects a development server action manifest.

Then run `npx tsc --noEmit`, `npm run lint`, and `docker build .`.

## Deployment review

The current deployment tracks `main` through Coolify. Review and human merge must precede that deployment. Keep the previous image until authenticated navigation, collection status, public-ingest boundaries, and existing usage totals are verified. Source identifiers and parser completeness must still be reconciled before a record-based cutover.
