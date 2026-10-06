# Netlify compatibility candidate

Use the canonical `codex/recover-root-revisions` branch. `netlify.toml` selects
the repository-root build and `apps/web` project. The build pins Node 24.21.0,
pnpm 11.5.3, Rust 1.99.0, wasm-bindgen 0.2.129 and Next.js adapter 5.16.1.
The newer adapter 5.16.2 was published within the dependency quarantine window;
keep the older pinned version rather than add an age-policy exception.
It builds the native gateway before recording the browser/server integrity
receipt, includes Rust/WASM, SQLite, bundled workers and the offline cache,
then checks tamper rejection before adapting Next.js.

Local packaging command:

```sh
python3 scripts/token_guard.py run 'npx --yes netlify-cli@27.11.1 build --offline --filter @needware/web && python3 scripts/verify-netlify-artifacts.py'
```

Packaging passes locally. Static assets retain their exact bytes; the Lambda
archive contains the handler's `/var/task/apps/web/...` imports and fits its
250 MiB uncompressed limit. `netlify serve` 27.11.1 with adapter 5.16.2 returned 500 locally because
those absolute Lambda paths are absent in its monorepo emulator. Four Chromium
runtime tests consequently fail there. Do not label this hosted acceptance.
Public HTTPS, runtime, offline reopen and browser tests remain required.

The authenticated Magnet team uses Legacy Free, has eight existing sites and
no saved payment card. Additional-team creation offers only paid plans; no team
was created and no plan was converted. Preserve its existing sites. Legacy Free
lacks background functions, so this deployment cannot run the current durable
generation worker. The separate compiler, bounded workers, database, email,
trusted ingress and provider acceptance remain blockers. Do not enable paid
fallback, publish live billing or claim a production release from this probe.

A frontend preview must use no production credentials. The native gateway built
here is an integrity input, not an automatically deployed private service.
