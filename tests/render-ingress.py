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
env = {**os.environ, "PORT": "3080", "NEEDWARE_PUBLIC_HOST": "needware.continuumarc.tech", "RENDER_EXTERNAL_HOSTNAME": "preview.onrender.com", "NEEDWARE_ALIAS_REDIRECT_HOST": "preview.onrender.com"}
child = subprocess.Popen(["caddy", "run", "--config", "/config/Caddyfile", "--adapter", "caddyfile"], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def request(host, path="/", spoof=False):
    conn = HTTPConnection("127.0.0.1", 3080, timeout=2)
    headers = {"Host": host}
    if spoof:
        headers.update({"X-Needware-Client-IP": "8.8.8.8", "X-Needware-Auth-IP": "8.8.4.4", "X-Forwarded-For": "1.2.3.4", "X-Forwarded-Host": "attacker.example.org", "X-Forwarded-Proto": "http", "X-Vercel-Forwarded-For": "1.1.1.1", "X-Real-IP": "9.9.9.9"})
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
    print("PASS Render real ingress identity, TLS forwarding, host rejection and canonical alias")
finally:
    child.terminate()
    child.wait(timeout=5)
    server.shutdown()
