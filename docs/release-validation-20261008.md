# Usage dashboard and collection status validation

Validated 2026-10-08 against the candidate based on `80379e160b61bc5672eed21d439f09d332d0fea9`.

- 52 verification scripts passed; TypeScript and ESLint exited 0. Tests used disposable MongoDB databases on loopback port 27398, never the deployment database.
- The candidate Docker image built successfully with the repository Dockerfile. The uploader archive is packaged into the image.
- Collection overview validation uses the actual HTTP response, verifies member-only access, distinguishes unknown counters from zero, keeps one source record across duplicate device receipts, and does not treat a device heartbeat as a tool record receipt.
- Existing usage reports: 40 assertions passed. Existing observation rendering: 6 checks passed. Forest, people view, request basis, total series, and price conversion suites also passed.
- Previous collection browser gate: 1360/390px, five tool details, keyboard open/close, error removes previous numbers, retry recovers, one status request on initial load.
- Record ingestion remains opt-in for installed uploaders. This release does not enable reviewed record cutover scopes, reinstall local collectors, backfill production records, or claim globally complete collection.
- Experiments remain controlled by `TOKEN_FOREST_EXPERIMENTS_MODE` (default `off`).

## Release review follow-up

- Independent review reproduced a heartbeat-only tool receiving a record receipt timestamp in the status API. Removed that assignment; the timestamp stays under device health. Collection overview (12 checks), record-ingest routes, collection adversarial (7 checks), TypeScript and targeted ESLint passed after the fix.
- CodeQL identified partial regular-expression escaping in two verification scripts. Their fixed test identity suffixes now use literal regular expressions. Re-ran `verify-ingest-v2.ts` (104 passed, 0 failed), `verify-machines.ts` (41 passed, 0 failed), TypeScript and targeted ESLint successfully. No application runtime source changed in this follow-up.
- Docker preview at `http://dev2.taild6091b.ts.net:4803/collection` uses disposable synthetic data. The running application shows the forest, an expanded people graph and both collection entry links; keyboard opening of Codex device details passed. This preview is not the production deployment.

## Reproduction

Run `src/scripts/verify-*` and `packages/uploader/src/scripts/verify-*` with the disposable database guards specified by each script. HTTP checks need a local application with cron disabled. The collection overview script requires `MONGODB_URI=mongodb://127.0.0.1:27398/tf-v2-test-collection-preview` and localhost port 4812. Experiment HTTP verification expects a development server action manifest.

Then run `npx tsc --noEmit`, `npm run lint`, and `docker build .`.

## Deployment review

The current deployment tracks `main` through Coolify. Review and human merge must precede that deployment. Keep the previous image until authenticated navigation, collection status, public-ingest boundaries, and existing usage totals are verified. Source identifiers and parser completeness must still be reconciled before a record-based cutover.
