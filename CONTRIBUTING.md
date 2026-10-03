# Contributing

Use the pinned toolchain and pnpm lockfile. Run `pnpm check` before committing. Changes use Conventional Commits and represent coherent, verified behavior. Tests should exercise domain invariants and trust boundaries.

Rust defines canonical application and protocol types. Browser/server contracts are generated. Never add arbitrary generated JavaScript, HTML, SQL, dynamically downloaded executable modules, or unbounded autonomous actions.

Keep specifications and project status aligned with code. Label fixtures and credentialed integration skips. Do not publish benchmarks without reproducible artifacts.
