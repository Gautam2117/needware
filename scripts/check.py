"""Consistent local and CI checks; invoked through token_guard."""
import pathlib
import subprocess

commands = [["cargo", "fmt", "--all", "--check"], ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"], ["cargo", "test", "--workspace"], ["python3", "scripts/security.py"]]
if pathlib.Path("apps/web/package.json").exists():
    commands += [["pnpm", "--filter", "@needware/web", "check"], ["pnpm", "--filter", "@needware/web", "test"]]
for command in commands:
    subprocess.run(command, check=True)
