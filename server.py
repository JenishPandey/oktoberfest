"""Static host for Alliance Arena on localhost:8000."""
import http.server, functools, os

ROOT = os.path.dirname(os.path.abspath(__file__))

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()
    def log_message(self, *a):
        pass

if __name__ == "__main__":
    handler = functools.partial(H, directory=ROOT)
    with http.server.ThreadingHTTPServer(("0.0.0.0", 8000), handler) as httpd:
        print(f"Serving {ROOT} on http://localhost:8000", flush=True)
        httpd.serve_forever()
