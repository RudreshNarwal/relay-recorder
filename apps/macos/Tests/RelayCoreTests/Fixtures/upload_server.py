"""Loopback contract fixture: real bytes, SHA256, retries, resume and finalization."""
import hashlib
import json
import sys
import time
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, parse_qs

VIDEO = "11111111-1111-4111-8111-111111111111"
REVISION = "22222222-2222-4222-8222-222222222222"
parts = {}
requests = []
fail_once = True
finalizes = 0
fail_part = None
fail_count = 0
cancels = 0
creates = 0
transcripts = []
transcript_failures = 0
transcription = None
reject_creation = False
ambiguous_creation = False
client_ids = []

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, data, status=200):
        payload = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def recording(self):
        return {"video": {"id": VIDEO, "initialRevisionId": REVISION, "status": "uploading"}, "upload": {"id": VIDEO, "partSize": 8388608, "receivedParts": list(parts)}}

    def check_auth(self):
        if self.headers.get("Authorization") != "Bearer test-token":
            self.reply({"error": "Unauthorized"}, 401)
            return False
        return True

    def do_GET(self):
        if self.path == "/stats":
            self.reply({"sizes": [len(parts[k]) for k in sorted(parts)], "requests": requests, "finalizes": finalizes, "cancels": cancels, "creates": creates, "transcripts": transcripts, "transcription": transcription, "clientIds": client_ids})
            return
        if not self.check_auth():
            return
        if urlsplit(self.path).path == "/api/v1/query-echo":
            self.reply(parse_qs(urlsplit(self.path).query))
            return
        if self.path == "/api/v1/redirect":
            self.send_response(302)
            self.send_header("Location", "/stats")
            self.send_header("Content-Length", "0")
            self.end_headers()
        elif self.path == f"/api/v1/recordings/{VIDEO}":
            self.reply(self.recording())
        else:
            self.reply({"error": self.path}, 404)

    def do_POST(self):
        global finalizes, fail_once, fail_part, fail_count, creates, transcript_failures, transcription, reject_creation, ambiguous_creation
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))))
        if not self.check_auth():
            return
        if self.path == "/api/v1/test-control":
            fail_once = False
            fail_part = body.get("failPart")
            fail_count = body.get("failCount", 0)
            transcript_failures = body.get("transcriptFailures", 0)
            reject_creation = body.get("rejectCreation", False)
            ambiguous_creation = body.get("ambiguousCreation", False)
            self.reply({})
        elif self.path == "/api/v1/recordings":
            client_ids.append(body["clientId"])
            if reject_creation:
                self.reply({"error": "Choose speech again", "code": "SPEECH_CONFIGURATION_UNAVAILABLE"}, 409)
                return
            creates += 1
            time.sleep(0.3)
            assert body["clientId"] and body["workspaceId"]
            transcription = body.get("transcription")
            if ambiguous_creation:
                self.reply({"error": "Upstream response lost"}, 503)
                return
            self.reply(self.recording())
        elif self.path == f"/api/v1/recordings/{VIDEO}/finalize":
            manifest = body["parts"]
            assert [p["index"] for p in manifest] == list(range(len(parts)))
            assert all(p["size"] == len(parts[p["index"]]) and p["sha256"] == hashlib.sha256(parts[p["index"]]).hexdigest() for p in manifest)
            finalizes += 1
            self.reply({"video": {"id": VIDEO, "initialRevisionId": REVISION, "status": "processing"}})
        else:
            self.reply({"error": self.path}, 404)

    def do_DELETE(self):
        global cancels
        if not self.check_auth():
            return
        assert self.path == f"/api/v1/recordings/{VIDEO}"
        cancels += 1
        self.reply({})

    def do_PUT(self):
        global fail_once, fail_count, transcript_failures
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if not self.check_auth():
            return
        if self.path == f"/api/v1/videos/{VIDEO}/transcript":
            value = json.loads(body)
            assert value["revisionId"] == REVISION and value["source"] == "on_device"
            if transcript_failures:
                transcript_failures -= 1
                self.reply({"error": "Speech upload temporarily unavailable"}, 503)
            else:
                transcripts.append(value)
                self.reply({"transcript": value})
            return
        index = int(self.path.rsplit("/", 1)[1])
        assert 0 < len(body) <= 8388608
        digest = hashlib.sha256(body).hexdigest()
        assert self.headers.get("X-Content-SHA256") == digest
        requests.append(index)
        if index == fail_part and fail_count > 0:
            fail_count -= 1
            self.reply({"error": "Later part failed"}, 503)
            return
        if fail_once:
            fail_once = False
            self.reply({"error": "Temporary outage"}, 503)
            return
        if index in parts and parts[index] != body:
            self.reply({"error": "Digest conflict"}, 409)
            return
        parts[index] = body
        self.reply({"index": index, "sha256": digest, "size": len(body)})

server = HTTPServer(("127.0.0.1", 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
