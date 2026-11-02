"""Private CPU Parakeet v3 service. No cloud speech APIs are used."""
from contextlib import asynccontextmanager
import asyncio
import hmac
import io
import math
import os
from pathlib import Path
import tempfile
import wave

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

PARAKEET_REPO = 'istupakov/parakeet-tdt-0.6b-v3-onnx'
PARAKEET_REVISION = '8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce'
VAD_REPO = 'istupakov/silero-vad-onnx'
VAD_REVISION = 'b3e3ee3cce4c11ceb63b1a0b229d916069c1ddf6'
MAX_BYTES = 512 * 1024 * 1024
MAX_SECONDS = 4 * 3600


class SpeechModels:
    """Share the pinned VAD between recognition and independent acoustic analysis."""
    def __init__(self, recognizer, vad):
        self.recognizer, self.vad = recognizer, vad

    def recognize(self, *args, **kwargs):
        return self.recognizer.recognize(*args, **kwargs)

    def analyze(self, path):
        import numpy as np
        with wave.open(str(path), 'rb') as audio:
            samples = np.frombuffer(audio.readframes(audio.getnframes()), dtype='<i2').astype(np.float32) / 32768
        detected = next(iter(self.vad.segment_batch(samples.reshape(1, -1), np.array([samples.size], dtype=np.int64), 16000,
            min_speech_duration_ms=50, min_silence_duration_ms=100, speech_pad_ms=0, max_speech_duration_s=30)))
        speech = [{'start': start / 16000, 'end': end / 16000} for start, end in detected]
        # VAD alone can call music, breaths, or quiet speech "non-speech".
        # Preserve any 20 ms block exceeding -60 dBFS before suggesting silence.
        audible = []
        for start in range(0, samples.size, 320):
            end = min(samples.size, start + 320)
            if np.max(np.abs(samples[start:end])) <= 0.001:
                continue
            if audible and abs(audible[-1]['end'] - start / 16000) < 1e-9:
                audible[-1]['end'] = end / 16000
            else:
                audible.append({'start': start / 16000, 'end': end / 16000})
        return {'speech': speech, 'audible': audible, 'model': 'silero', 'revision': VAD_REVISION}


def load_model():
    """Cache immutable, quantized ONNX assets, then load CPU-only sessions."""
    import onnx_asr
    import onnxruntime as ort
    from huggingface_hub import snapshot_download
    cache = Path(os.environ.get('ASR_MODEL_DIR', '/models'))
    cache.mkdir(parents=True, exist_ok=True)
    model_path = snapshot_download(PARAKEET_REPO, revision=PARAKEET_REVISION,
        cache_dir=str(cache), allow_patterns=['config.json', 'vocab.txt', '*.int8.onnx', 'nemo128.onnx'])
    vad_path = snapshot_download(VAD_REPO, revision=VAD_REVISION, cache_dir=str(cache),
        allow_patterns=['config.json', '*.onnx'])
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, min(8, int(os.environ.get('ASR_THREADS', '4'))))
    options.inter_op_num_threads = 1
    model = onnx_asr.load_model('nemo-parakeet-tdt-0.6b-v3', model_path,
        quantization='int8', sess_options=options, providers=['CPUExecutionProvider'])
    vad = onnx_asr.load_vad('silero', vad_path, sess_options=options, providers=['CPUExecutionProvider'])
    return SpeechModels(model.with_vad(vad).with_timestamps(), vad)


def timed_segment(result, duration):
    start, end = max(0.0, float(result.start)), min(duration, float(result.end))
    if not math.isfinite(start) or not math.isfinite(end) or end <= start:
        raise ValueError('Invalid model timestamps')
    segment = {'start': start, 'end': end, 'text': result.text.strip()}
    tokens, timestamps = getattr(result, 'tokens', None), getattr(result, 'timestamps', None)
    if tokens and timestamps and len(tokens) == len(timestamps):
        words = []
        for token, timestamp in zip(tokens, timestamps):
            if token.startswith('<') and token.endswith('>'):
                continue
            when = min(end, max(start, start + float(timestamp)))
            if not math.isfinite(when):
                raise ValueError('Invalid word timestamp')
            boundary = token.startswith('▁') or token.startswith(' ')
            text = token.replace('▁', ' ')
            if boundary or not words:
                if words:
                    words[-1]['end'] = max(words[-1]['start'] + 0.001, when)
                words.append({'start': when, 'end': end, 'text': text.lstrip()})
            else:
                words[-1]['text'] += text
        segment['words'] = [word for word in words if word['text'] and word['end'] > word['start']]
    return segment


def normalize_results(results, duration):
    return [timed_segment(result, duration) for result in results if result.text.strip()]


def inspect_wav(data):
    try:
        with wave.open(io.BytesIO(data), 'rb') as wav:
            if wav.getnchannels() != 1 or wav.getframerate() != 16000 or wav.getsampwidth() != 2 or wav.getcomptype() != 'NONE':
                raise ValueError('Expected 16 kHz mono PCM16 WAV')
            frames = wav.getnframes()
            duration = frames / 16000
            if frames <= 0 or duration > MAX_SECONDS:
                raise ValueError('Audio duration exceeds service bounds')
            if len(wav.readframes(frames)) != frames * 2:
                raise ValueError('Truncated WAV')
            return duration
    except (wave.Error, EOFError) as error:
        raise ValueError('Invalid WAV') from error


def create_app(model_loader=load_model, token=None):
    secret = token if token is not None else os.environ.get('INTERNAL_API_TOKEN', '')
    state = {'model': None}
    gate = asyncio.Semaphore(1)

    @asynccontextmanager
    async def lifespan(application):
        if not secret or len(secret) < 12:
            raise RuntimeError('INTERNAL_API_TOKEN must contain at least 12 characters')
        # Startup fails closed; readiness never reports true before sessions load.
        state['model'] = await run_in_threadpool(model_loader)
        yield
        state['model'] = None

    application = FastAPI(title='Relay private Parakeet ASR', lifespan=lifespan,
        docs_url=None, redoc_url=None, openapi_url=None)

    @application.middleware('http')
    async def bounded_upload(request: Request, call_next):
        if request.method == 'POST':
            authorization = request.headers.get('authorization', '')
            if not hmac.compare_digest(authorization, 'Bearer ' + secret) or not secret:
                return JSONResponse({'error': 'Unauthorized'}, status_code=401)
            try:
                size = int(request.headers.get('content-length', '-1'))
            except ValueError:
                size = -1
            if size < 0:
                return JSONResponse({'error': 'Content-Length required'}, status_code=411)
            if size > MAX_BYTES + 65536:
                return JSONResponse({'error': 'Audio too large'}, status_code=413)
        return await call_next(request)

    @application.get('/health')
    async def health():
        ready = state['model'] is not None
        return JSONResponse({'ok': ready, 'model': 'parakeet-tdt-0.6b-v3',
            'revision': PARAKEET_REVISION}, status_code=200 if ready else 503)

    @application.post('/transcribe')
    async def transcribe(audio: UploadFile = File(...)):
        return await process(audio, analysis=False)

    @application.post('/analyze')
    async def analyze(audio: UploadFile = File(...)):
        return await process(audio, analysis=True)

    async def process(audio: UploadFile, analysis: bool):
        if state['model'] is None:
            raise HTTPException(503, 'ASR not ready')
        try:
            await asyncio.wait_for(gate.acquire(), timeout=0.05)
        except TimeoutError:
            raise HTTPException(429, 'ASR busy', headers={'Retry-After': '5'})
        try:
            data = await audio.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise HTTPException(413, 'Audio too large')
            try:
                duration = inspect_wav(data)
                if analysis and duration > 1800:
                    raise ValueError('Analysis windows must not exceed 30 minutes')
            except ValueError as error:
                raise HTTPException(415, str(error)) from error
            with tempfile.TemporaryDirectory(prefix='relay-asr-') as directory:
                path = Path(directory) / 'audio.wav'
                path.write_bytes(data)
                del data
                def recognize():
                    if analysis:
                        return state['model'].analyze(path)
                    results = state['model'].recognize(str(path), batch_size=1,
                        max_speech_duration_s=20, min_silence_duration_ms=250,
                        speech_pad_ms=80)
                    return normalize_results(results, duration)
                try:
                    segments = await run_in_threadpool(recognize)
                except Exception as error:
                    # Model exceptions may include local paths; never expose them over HTTP.
                    raise HTTPException(500, 'Speech recognition failed') from error
                return segments if analysis else {'segments': segments}
        finally:
            gate.release()
            await audio.close()

    return application


app = create_app()
