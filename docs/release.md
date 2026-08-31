# Release Process

## Versioning

Semantic versioning. `CHANGELOG.md` must be updated before every release.

## Release steps

1. **Finalize the changelog**
   - Move `[Unreleased]` items into a new `## [x.y.z] - YYYY-MM-DD` section.
2. **Validate**
   ```bash
   npm ci
   npm run build          # tsc -b + esbuild bundle
   npm run lint
   npm run format:check
   npm test               # unit/protocol/contract/integration/security
   npm run validate:manifests
   ```
3. **Package**
   ```bash
   npm run package
   ```
   Produces in `release/`:
   - `codex-cursor-bridge-cli-<ver>.zip` — bundle + installers + LICENSE/NOTICE
   - `codex-cursor-bridge-plugin-cursor-<ver>.zip`
   - `codex-cursor-bridge-plugin-codex-<ver>.zip`
   - `SHA256SUMS`
   - `sbom-codex-cursor-bridge-<ver>.json` (CycloneDX subset)
4. **Tag & GitHub release**
   ```bash
   git tag -a v<x.y.z> -m "v<x.y.z>"
   git push origin v<x.y.z>
   gh release create v<x.y.z> release/*.zip release/SHA256SUMS release/sbom-*.json \
     --title "v<x.y.z>" --notes-file <(sed -n "/## \[x.y.z\]/,/## \[/p" CHANGELOG.md | head -n -1)
   ```
   The release workflow (`.github/workflows/release.yml`) performs the same
   steps on tag push and attaches artifacts automatically.
5. **Announce** with compatibility notes (docs/compatibility.md) for any
   protocol version bumps.

## Determinism

- Zip contents get fixed mtimes (2026-01-01T00:00:00Z) before packing.
- `npm ci` (not install) guarantees the lockfile tree.
- `SHA256SUMS` covers all zips; verify with `shasum -a 256 -c SHA256SUMS`.

## Plugin installation formats

- Manifests reference the CLI by name (`codex-cursor-bridge`) so they work
  from PATH, or by absolute path after the user edits `command` — documented
  in both plugin READMEs. No `node_modules` is shipped; the bundle is
  self-contained.
- `dist/` is not committed to the repository; release archives carry the
  prebuilt `bundles/codex-cursor-bridge.mjs` instead (source installs build
  locally with `npm run build`).

## After release

- Bump `version` in `package.json` (root + plugin manifests) to the next
  `-dev` patch in the same commit as the changelog reset.
- Check GitHub issues for compatibility reports
  (`.github/ISSUE_TEMPLATE/compatibility_report.yml`).
