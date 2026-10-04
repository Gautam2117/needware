# Dependency audit policy

`pnpm audit:dependencies` checks RustSec advisories, cargo-deny licenses/sources
and JavaScript advisories at moderate severity or higher. CI runs the same checks.
No advisory is ignored. Internal Rust path dependencies carry exact release
versions so wildcard dependencies cannot silently enter the release graph.

Next lint plugin 16.3.8 used fast-glob/micromatch/braces. The installed braces
3.0.3 has [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm),
with no upstream patched release available at verification on 2026-10-04.
The committed pnpm patch changes its sole glob import to tinyglobby 0.2.17.
A package extension supplies that dependency; a version-scoped override removes
the unused fast-glob edge. The lockfile contains no braces or micromatch.

`scripts/verify_lint_patch.mjs` checks glob/array/missing/backslash root settings
and actual Next lint diagnostics. Frozen installs apply and validate the patch;
an upstream plugin update must revalidate or remove this version-scoped change.
An audit pass records known advisories at that time, not independent security
review or production penetration testing.
