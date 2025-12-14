"""
Simple streaming HTTP server that exposes scan results for the frontend.

Endpoints:
    GET /                 - Serves the frontend (index.html) from ./frontend
    GET /api/scan/stream  - Streams NDJSON of all scan results as they complete
"""

from __future__ import annotations

import argparse
import json
import os
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from typing import Iterable

import bash

SCAN_FUNCS = [getattr(bash, name) for name in bash.SCAN_FUNCTIONS]


def iter_scan_results() -> Iterable[dict]:
    """Yield command results from each scan function sequentially."""
    for fn in SCAN_FUNCS:
        try:
            results = fn()
        except Exception as exc:  # pragma: no cover - defensive
            yield {
                "category": getattr(fn, "__name__", "scan"),
                "command": "",
                "stdout": "",
                "stderr": f"Scan function failed: {exc}",
                "returncode": -1,
                "path": None,
                "note": "Internal scan error.",
                "parsed_sizes": None,
            }
            continue

        for result in results:
            yield result


class StreamingHandler(SimpleHTTPRequestHandler):
    """Serve static frontend assets and stream scan data as NDJSON."""

    protocol_version = "HTTP/1.1"

    def do_GET(self):  # noqa: N802 - required by BaseHTTPRequestHandler
        if self.path.rstrip("/") == "/api/scan/stream":
            return self.handle_stream()
        return super().do_GET()

    def handle_stream(self) -> None:
        """Stream NDJSON scan results to the client."""
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Connection", "close")
        # Explicit chunked encoding for browsers that rely on it to stream.
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()

        def send_chunk(data: str) -> None:
            encoded = data.encode("utf-8")
            self.wfile.write(f"{len(encoded):X}\r\n".encode("utf-8"))
            self.wfile.write(encoded)
            self.wfile.write(b"\r\n")
            self.wfile.flush()

        try:
            for result in iter_scan_results():
                send_chunk(json.dumps(result) + "\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
        except BrokenPipeError:
            pass
        except Exception as exc:  # pragma: no cover - runtime guardrail
            try:
                send_chunk(
                    json.dumps(
                        {
                            "category": "server",
                            "command": "",
                            "stdout": "",
                            "stderr": f"Server error: {exc}",
                            "returncode": -1,
                            "path": None,
                            "note": "Streaming aborted.",
                            "parsed_sizes": None,
                        }
                    )
                )
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except Exception:
                pass

    def log_message(self, fmt: str, *args) -> None:
        """Silence default request logs to keep console tidy."""
        return


def main() -> None:
    parser = argparse.ArgumentParser(description="Stream Mac Cleaner scan results.")
    parser.add_argument("--port", type=int, default=8000, help="Port to bind to.")
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Interface to bind to (default: localhost).",
    )
    parser.add_argument(
        "--directory",
        default=os.path.join(os.path.dirname(__file__), "frontend"),
        help="Directory to serve static files from.",
    )
    args = parser.parse_args()

    handler = lambda *handler_args, **handler_kwargs: StreamingHandler(  # noqa: E731
        *handler_args, directory=args.directory, **handler_kwargs
    )

    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(
        f"Serving frontend at http://{args.host}:{args.port} (directory: {args.directory})"
    )
    print("Streaming endpoint: /api/scan/stream")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
