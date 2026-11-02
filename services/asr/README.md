# Private Parakeet v3 API

Python 3.11 or later, macOS Apple Silicon or Linux CPU. Install `requirements.txt`, set `INTERNAL_API_TOKEN` to a strong shared secret, and run `uvicorn app:app --host 127.0.0.1 --port 8100 --workers 1` from this directory. Docker binds internally on 8100; do not expose it publicly. Set `ASR_MODEL_DIR` to a persistent writable directory (default `/models`), and optionally `ASR_THREADS` (1–8, default 4).

Startup downloads immutable pinned Parakeet v3 int8 ONNX and Silero VAD assets, reuses Hugging Face's local cache, and loads CPU sessions before readiness. First startup needs network access and roughly 1 GB for weights. Subsequent startup can use the cache with `HF_HUB_OFFLINE=1`. Model revisions are fixed in `app.py`; updating them is an explicit deployment change.

`GET /health` reports readiness and model revision. `POST /transcribe` requires `Authorization: Bearer <INTERNAL_API_TOKEN>`, `Content-Length`, and multipart field `audio` containing mono PCM16 WAV at 16 kHz. Limit: 512 MiB and four hours. One inference runs at a time; excess work receives 429. VAD splits long recordings into at most 20-second speech windows. Token timestamps become word intervals, offset onto the original recording timeline; silence produces an empty segment list. Parakeet v3 supports its built-in multilingual recognition; this service does not guess a language label.

Run tests from the repository root with a disposable Python 3.11 virtual environment:

```sh
python3.11 -m venv .venv-asr
. .venv-asr/bin/activate
python -m pip install fastapi==0.135.1 python-multipart==0.0.22 httpx==0.28.1
python -m unittest discover -s tests -p 'asr_test.py'
deactivate
```

The focused suite reports five tests. It uses fake model and VAD components, so it does not download model weights. The dependency pins match the lightweight ASR CI job in `.github/workflows/ci.yml`; they omit the model runtime.

Alternatively, `uv` can create and manage the temporary environment for you. Run this command from the repository root:

```sh
uv run --python 3.11 --with fastapi --with httpx --with python-multipart python -m unittest discover -s tests -p 'asr_test.py'
```

These focused tests exercise authentication, WAV validation, silence and timestamp offsets without downloading weights. Run real pinned-model speech/silence verification with a mono PCM16 16 kHz WAV containing the word “hello” (or set `ASR_EXPECT_TEXT`):

```sh
ASR_MODEL_DIR=services/asr/.models ASR_LIVE_TEST=1 ASR_TEST_WAV=/path/to/speech.wav \
  services/asr/.venv/bin/python -m unittest discover -s tests -p 'asr_model_test.py'
```

`tests/worker-asr.test.ts` additionally exercises the complete worker-to-HTTP transcription path when `TEST_DATABASE_URL`, `ASR_LIVE_TEST=1`, `ASR_TEST_WAV`, `ASR_URL`, and `INTERNAL_API_TOKEN` are set. Use a dedicated migrated test database; worker fixtures create and remove temporary users and videos.
