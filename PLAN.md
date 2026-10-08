# Plan: Sync main with upstream/main and Build/Deploy New Image

## Current State Verification
- **Deployment**: freellmapi service runs on pi5 node (pod `freellmapi-56b5569589-5nm8d`, image `ghcr.io/tashfeenahmed/freellmapi:latest`).
- **Ingress**: `freellmapi` (websecure, TLS) + `freellm-http` (web, redirect) route traffic to https://freellm.aldof.duckdns.org.
- **Git Status** (as of `dbac4f3c`):
  - `upstream/main`: `b882473c3a23251be312a7270e2e0dc1eae1329d`
  - `origin/main` = `main`: `dbac4f3c07ac06c18f2dbdd241e1125667f47982`
  - `main` is **75 commits ahead** of `upstream/main`, **0 behind**.
  - `origin/main` is identical to local `main`.
  - Merge-base: `b882473c3a23251be312a7270e2e0dc1eae1329d`.

## Critical Decision Point
To achieve the goal *"start from upstream/main and have upstream/main equal origin/main"*, one of the following must occur:
1. **Reset `origin/main` to `upstream/main`** (discard 75 commits).
   - **Consequence**: Loss of 75 commits of feature work (e.g., Plugsky, ElectronHub, Typhoon speech support, updates dialog, etc.).
   - **Command**: `git push origin +b882473c3a23251be312a7270e2e0dc1eae1329d:main` (force-push).
2. **Keep `origin/main` as-is** and interpret the goal differently:
   - Create a temporary build branch from `upstream/main` for image build, leaving `origin/main` unchanged.
   - After build, return to `main` (which remains 75 ahead of upstream).
   - This preserves work but does NOT make `upstream/main == origin/main`.

> **Required**: User confirmation on whether to discard the 75 commits or pursue an alternative interpretation.

## Proposed Workflow (Assuming Reset is Confirmed)
1. **Sync Branches**:
   ```bash
   git fetch upstream
   git checkout main
   git reset --hard upstream/main   # or: git reset --hard b882473c3a23251be312a7270e2e0dc1eae1329d
   git push origin main --force     # update origin/main to match upstream/main
   ```
   - After this: `upstream/main == origin/main == main` (all at `b882473c3a23251be312a7270e2e0dc1eae1329d`).

2. **Build New Image**:
   ```bash
   npm ci                         # clean install (if needed)
   npm run build                  # builds server, cli, client
   # Docker build (using Dockerfile at repo root):
   docker build -t ghcr.io/aldo-f/freellmapi:latest -f Dockerfile .
   ```
   **Important**: The image is tagged `ghcr.io/aldo-f/freellmapi:latest` — **your fork's image**, not the upstream's. Build it from your local `main` (which includes upstream + your change).

3. **Push to Your Registry**:
   ```bash
   docker login ghcr.io                 # use username + personal access token
   docker push ghcr.io/aldo-f/freellmapi:latest
   ```
   You have write access to `ghcr.io/aldo-f/...` (your GitHub user); the upstream image (`tashfeenahmed/...`) is pull-only for you.

4. **Deploy Updated Image**:
   ```bash
   # Update deployment to use YOUR image
   kubectl set image deployment/freellmapi freellmapi=ghcr.io/aldo-f/freellmapi:latest -n default
   # Rollout restart (rolling update)
   kubectl rollout restart deployment/freellmapi -n default
   # Verify rollout:
   kubectl rollout status deployment/freellmapi -n default
   kubectl get pods -n default -l app=freellmapi
   ```

4. **Return to Development Workflow**:
   ```bash
   git checkout -b feature/<new-work>   # branch from main (now at upstream)
   # ... make changes ...
   git push origin feature/<new-work>
   # Open PR to origin/main (which tracks upstream/main)
   # After merge, checkout main again and repeat.
   ```

## Notes
- The Docker image currently in use is built from upstream's `main` (via GitHub Actions likely). Building locally ensures we test the exact code we intend to deploy.
- Encryption key (`ENCRYPTION_KEY`) is sourced from deployment environment; ensure it is available in build environment if needed for binary (but typically only runtime).
- After reset, the 75 commits are **lost unless preserved elsewhere** (e.g., on a backup branch). Consider creating a backup branch before reset:
  ```bash
  git backup upstream/main..origin/main   # or: git branch pre-reset-backup dbac4f3c
  ```

## Verification Steps
1. Confirm `kubectl get deployment` shows new image hash or updated timestamp.
2. Hit https://freellm.aldof.duckdns.org and verify new features absent (since we reset to upstream) or present (if we kept commits).
3. Check pod logs for startup errors.

## Alternate Interpretation (If Preserving Work)
If the 75 commits must be kept:
- Do NOT reset branches.
- To build from `upstream/main` while preserving `origin/main`:
  ```bash
  git checkout -b build-temp upstream/main
  npm run build
  docker build -t ghcr.io/tashfeenahmed/freellmapi:latest -f docker/Dockerfile .
  # deploy as above
  git checkout main   # return to original main (75 ahead)
  git branch -D build-temp
  ```
- Then `origin/main` remains 75 ahead of `upstream/main`; workflow continues via branches.

---
**Next Step**: Await user confirmation on whether to proceed with reset (discarding 75 commits) or use the alternate interpretation.