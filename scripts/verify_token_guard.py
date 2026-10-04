"""Exercise parallel verification with identical timestamps and mixed exit codes."""
import pathlib
import re
import shlex
import stat
import subprocess
import sys
import tempfile

guard = pathlib.Path(__file__).with_name("token_guard.py").resolve()
runner = """
import datetime, runpy, sys
from unittest.mock import patch
class FrozenClock(datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        return cls(2026, 10, 4, 0, 0, 0, tzinfo=tz)
namespace = runpy.run_path(sys.argv[1])
sys.argv = [sys.argv[1], 'run', sys.argv[2]]
with patch('datetime.datetime', FrozenClock):
    sys.exit(namespace['main']())
"""
with tempfile.TemporaryDirectory(prefix="needware-log-isolation-") as directory:
    running = []
    for label, code in [("first", 0), ("failed", 7), ("last", 0)]:
        source = f"import time,sys; print({label!r},flush=True); time.sleep(.15); print({(label + ' completed')!r},flush=True); sys.exit({code})"
        command = shlex.join([sys.executable, "-c", source])
        process = subprocess.Popen([sys.executable, "-c", runner, str(guard), command], cwd=directory,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        running.append((process, label, code))
    paths = []
    for process, label, code in running:
        output, error = process.communicate(timeout=30)
        assert process.returncode == code, error
        match = re.search(r"log=(\S+)", output)
        assert match, output
        path = pathlib.Path(directory) / match[1]
        assert path.read_text() == f"{label}\n{label} completed\n"
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
        paths.append(path)
    assert len(set(paths)) == 3
    assert len(list((pathlib.Path(directory) / ".logs").iterdir())) == 3
print("PASS independent retained logs and exit codes under concurrent identical timestamps")
