"""Verify the real Render ingress without contacting external services."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
from http.client import HTTPConnection
import json
import os
import subprocess
import time

class Echo(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(json.dumps(dict(self.headers)).encode())
    def log_message(self, *args):
        pass

server = HTTPServer(("127.0.0.1", 3000), Echo)
Thread(target=server.serve_forever, daemon=True).start()
proof = "a" * 64
env = {**os.environ, "PORT": "3080", "NEEDWARE_PUBLIC_HOST": "needware.continuumarc.tech", "NEEDWARE_ACCEPTED_HOSTS": "needware.continuumarc.tech preview.onrender.com", "RENDER_EXTERNAL_HOSTNAME": "preview.onrender.com", "NEEDWARE_ALIAS_REDIRECT_HOST": "preview.onrender.com", "NEEDWARE_EDGE_ORIGIN_PROOF": proof}
child = subprocess.Popen(["caddy", "run", "--config", "/config/Caddyfile", "--adapter", "caddyfile"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def request(host, path="/", spoof=False, extra=None):
    conn = HTTPConnection("127.0.0.1", 3080, timeout=2)
    headers = {"Host": host}
    if spoof:
        headers.update({"X-Needware-Client-IP": "8.8.8.8", "X-Needware-Auth-IP": "8.8.4.4", "X-Forwarded-For": "1.2.3.4", "X-Forwarded-Host": "attacker.example.org", "X-Forwarded-Proto": "http", "X-Vercel-Forwarded-For": "1.1.1.1", "X-Real-IP": "9.9.9.9"})
    headers.update(extra or {})
    conn.request("GET", path, headers=headers)
    response = conn.getresponse()
    result = (response.status, dict(response.getheaders()), response.read())
    conn.close()
    return result
try:
    for attempt in range(50):
        try:
            result = request("needware.continuumarc.tech", spoof=True)
            break
        except OSError:
            if child.poll() is not None:
                raise RuntimeError("Proxy exited")
            time.sleep(0.1)
    assert result[0] == 200
    headers = {key.lower(): value for key, value in json.loads(result[2]).items()}
    assert headers["x-needware-client-ip"] == "127.0.0.1"
    assert headers["x-forwarded-proto"] == "https"
    assert headers["x-forwarded-host"] == "needware.continuumarc.tech"
    for name in ["x-needware-auth-ip", "x-forwarded-for", "x-vercel-forwarded-for", "x-real-ip"]:
        assert name not in headers
    assert request("attacker.example.org")[0] == 421
    alias = request("preview.onrender.com", "/registry?review=1")
    assert alias[0] == 308
    assert alias[1]["Location"] == "https://needware.continuumarc.tech/registry?review=1"
    assert request("preview.onrender.com", "/api/health")[0] == 200
    assert request("preview.onrender.com", extra={"X-Needware-Origin-Proof": "forged", "X-Needware-Edge-IP": "8.8.8.8"})[0] == 308
    edge = request("preview.onrender.com", spoof=True, extra={"X-Needware-Origin-Proof": proof, "X-Needware-Edge-IP": "2001:db8::1"})
    assert edge[0] == 200
    forwarded = {key.lower(): value for key, value in json.loads(edge[2]).items()}
    assert forwarded["host"] == "needware.continuumarc.tech"
    assert forwarded["x-forwarded-host"] == "needware.continuumarc.tech"
    assert forwarded["x-needware-client-ip"] == "2001:db8::1"
    assert "x-needware-origin-proof" not in forwarded
    assert "x-needware-edge-ip" not in forwarded
    child.terminate()
    child.wait(timeout=5)
    preview_env = {**env, "NEEDWARE_PUBLIC_HOST": "preview.onrender.com", "NEEDWARE_ACCEPTED_HOSTS": "preview.onrender.com", "NEEDWARE_ALIAS_REDIRECT_HOST": "never-redirect.invalid"}
    child = subprocess.Popen(["caddy", "run", "--config", "/config/Caddyfile", "--adapter", "caddyfile"], env=preview_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for attempt in range(50):
        try:
            same = request("preview.onrender.com", "/api/health")
            break
        except OSError:
            if child.poll() is not None:
                raise RuntimeError("Single-host preview proxy exited")
            time.sleep(0.1)
    assert same[0] == 200
    assert request("attacker.example.org")[0] == 421
    print("PASS Render real ingress identity, TLS forwarding, host rejection and canonical alias")
finally:
    child.terminate()
    child.wait(timeout=5)
    server.shutdown()
