"""Disposable Linux container: verify the actual proxy overwrites spoofed IPs."""
from http.server import BaseHTTPRequestHandler, HTTPServer
from threading import Thread
import json
import os
import subprocess
import time
import urllib.request

class Echo(BaseHTTPRequestHandler):
    def do_GET(self):
        data = json.dumps(dict(self.headers)).encode()
        self.send_response(200)
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass

server = HTTPServer(("127.0.0.1", 3000), Echo)
Thread(target=server.serve_forever, daemon=True).start()
child = subprocess.Popen(["caddy", "run", "--config", "/config/Caddyfile", "--adapter", "caddyfile"], env={**os.environ, "NEEDWARE_PUBLIC_HOST": "http://127.0.0.1:3080"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    response = None
    for attempt in range(50):
        try:
            request = urllib.request.Request("http://127.0.0.1:3080/", headers={"X-Needware-Client-IP": "8.8.8.8", "X-Needware-Auth-IP": "8.8.4.4", "X-Vercel-Forwarded-For": "1.1.1.1", "X-Real-IP": "9.9.9.9"})
            with urllib.request.urlopen(request, timeout=1) as result:
                response = {key.lower(): value for key, value in json.load(result).items()}
            break
        except OSError:
            if child.poll() is not None:
                raise RuntimeError("Proxy exited")
            time.sleep(0.1)
    assert response is not None
    assert response["x-needware-client-ip"] == "127.0.0.1"
    for name in ["x-needware-auth-ip", "x-vercel-forwarded-for", "x-real-ip"]:
        assert name not in response, name
    print("PASS real Caddy proxy overwrites client identity and strips spoofed auth/platform headers")
finally:
    child.terminate()
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    server.shutdown()
