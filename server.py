"""Static host for Alliance Arena on localhost:8000 + Gemini proxy.

Serves the game statically and proxies NPC brain calls to Google's
Generative Language API (Gemini) so the browser never holds the API key.

  GET  /api/health -> {"ok": true, "model": ...}
  GET  /api/models -> {"models": [...]} (live list from Google)
  POST /api/gemini -> {"text": "..."} (forwards to :generateContent)

Frontend contract for POST /api/gemini:
  {"model": "...", "system": "...", "history": [{"role":"user|model","text":"..."}],
   "prompt": "...", "temperature": 0.7, "maxTokens": 200, "json": false}
"""
import http.server
import functools
import json
import os
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))

# Never hardcode the key here — GitHub push protection (and Google's leaked-key
# enforcement) will reject/disable it. Run with: GOOGLE_API_KEY=<key> python3 server.py
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")
DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash-lite")
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


def gemini_generate(model, system, history, prompt, temperature, max_tokens):
    contents = []
    for m in history or []:
        role = "model" if m.get("role") in ("model", "assistant") else "user"
        text = str(m.get("text", m.get("content", "")))
        if text:
            contents.append({"role": role, "parts": [{"text": text}]})
    if prompt:
        contents.append({"role": "user", "parts": [{"text": str(prompt)}]})
    body = {
        "contents": contents or [{"role": "user", "parts": [{"text": "Hello"}]}],
        "generationConfig": {
            "temperature": float(temperature if temperature is not None else 0.7),
            "maxOutputTokens": int(max_tokens or 300),
        },
    }
    if system:
        body["system_instruction"] = {"parts": [{"text": str(system)}]}
    # NOTE: responseMimeType application/json forces valid JSON but also
    # disables natural 2-line TALK replies, so we never set it here.
    # ACTION callers ask for JSON in prose and parse the text instead.
    url = f"{GEMINI_BASE}/{model or DEFAULT_MODEL}:generateContent"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": GOOGLE_API_KEY,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:2000]
        raise RuntimeError(f"gemini {e.code}: {detail}")
    parts = (
        (data.get("candidates") or [{}])[0]
        .get("content", {})
        .get("parts", [])
    )
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict)).strip()
    if not text and data.get("candidates"):
        raise RuntimeError(f"gemini empty reply: {json.dumps(data)[:500]}")
    return text


class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass

    def _json(self, obj, status=200):
        raw = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path == "/api/health":
            masked = (GOOGLE_API_KEY[:6] + "..." + GOOGLE_API_KEY[-4:]) if GOOGLE_API_KEY else "missing"
            return self._json({"ok": True, "model": DEFAULT_MODEL, "key": masked})
        if self.path == "/api/models":
            try:
                req = urllib.request.Request(
                    f"{GEMINI_BASE}?pageSize=100",
                    headers={"x-goog-api-key": GOOGLE_API_KEY},
                    method="GET",
                )
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = json.loads(r.read().decode())
                names = [m["name"].replace("models/", "") for m in data.get("models", [])]
                return self._json({"models": names})
            except Exception as e:
                return self._json({"error": str(e)[:500]}, status=502)
        return super().do_GET()

    def do_POST(self):
        if self.path != "/api/gemini":
            return self._json({"error": "not found"}, status=404)
        try:
            length = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(length).decode() or "{}")
        except Exception as e:
            return self._json({"error": f"bad json: {e}"}, status=400)
        try:
            text = gemini_generate(
                payload.get("model") or DEFAULT_MODEL,
                payload.get("system") or "",
                payload.get("history") or [],
                payload.get("prompt") or "",
                payload.get("temperature", 0.7),
                payload.get("maxTokens", 300),
            )
            return self._json({"text": text, "model": payload.get("model") or DEFAULT_MODEL})
        except Exception as e:
            return self._json({"error": str(e)[:2000]}, status=502)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


if __name__ == "__main__":
    handler = functools.partial(H, directory=ROOT)
    with http.server.ThreadingHTTPServer(("0.0.0.0", 8000), handler) as httpd:
        print(f"Serving {ROOT} on http://localhost:8000 (gemini proxy model={DEFAULT_MODEL})", flush=True)
        httpd.serve_forever()
