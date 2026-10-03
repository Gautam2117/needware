"""Bound browser failure summaries; full traces are separate CI artifacts."""
import json
import pathlib

path = pathlib.Path("artifacts/browser-results.json")
if path.exists():
    def report(suite):
        for spec in suite.get("specs", []):
            for test in spec["tests"]:
                for result in test["results"]:
                    if result["status"] != "passed":
                        errors = result.get("errors", [])[:2]
                        message = " | ".join(e.get("message", "") for e in errors)
                        print(f"FAIL {test['projectName']} {spec['title']}: {' '.join(message.split())[:1200]}")
        for child in suite.get("suites", []):
            report(child)
    report(json.loads(path.read_text()))
