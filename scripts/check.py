"""Consistent local and CI checks; invoked through token_guard."""
import pathlib
import subprocess

commands = [["python3", "scripts/verify_token_guard.py"], ["cargo", "fmt", "--all", "--check"], ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"], ["cargo", "test", "--workspace"], ["python3", "scripts/security.py"]]
if pathlib.Path("apps/web/package.json").exists():
    commands += [["cargo", "run", "-p", "xtask", "--", "epoch-proof-fixture"], ["pnpm", "--filter", "@needware/web", "check"], ["pnpm", "--filter", "@needware/web", "test"], ["node", "scripts/verify_lint_patch.mjs"], ["node", "scripts/verify_environment.mjs"], ["node", "scripts/verify_worker_deadlines.mjs"]]
commands += [["pnpm", "--filter", "@needware/web", "exec", "tsc", "--project", "../../packages/runtime-frame/tsconfig.json"], ["node", "--test", "scripts/acceptance-clock.test.mjs"]]
commands += [["node", "--test", "scripts/production-preflight.test.mjs"]]
commands += [["node", "--test", "scripts/prepare-cashfree-live.test.mjs"]]
commands += [["node", "scripts/verify-free-model-policy.mjs"], ["node", "--check", "scripts/benchmark-free-models.mjs"]]
commands += [["node", "--check", path] for path in ["scripts/backup-lib.mjs", "scripts/backup.mjs", "scripts/verify_backup_scope.mjs"]]
for command in commands:
    subprocess.run(command, check=True)
