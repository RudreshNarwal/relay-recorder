import importlib.util
import io
import os
from pathlib import Path
from types import SimpleNamespace
import unittest
import wave

spec=importlib.util.spec_from_file_location('relay_asr',Path(__file__).resolve().parents[1]/'services/asr/app.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class AsrTests(unittest.TestCase):
    def test_token_times_add_vad_offset_and_join_sentencepiece_words(self):
        result=SimpleNamespace(start=10.0,end=12.0,text='Hello world',tokens=['▁Hello','▁wor','ld'],timestamps=[0.1,0.6,0.8])
        self.assertEqual(module.timed_segment(result,15),{'start':10.0,'end':12.0,'text':'Hello world','words':[{'start':10.1,'end':10.6,'text':'Hello'},{'start':10.6,'end':12.0,'text':'world'}]})

    def test_silence_yields_no_invented_segments(self):
        self.assertEqual(module.normalize_results([],60),[])

    def test_auth_missing_token_and_invalid_audio_never_run_inference(self):
        from fastapi.testclient import TestClient
        class Model:
            def recognize(self,*args,**kwargs):
                raise AssertionError('Unauthorized input reached inference')
        application=module.create_app(lambda:Model(),token='internal-secret')
        with TestClient(application) as client:
            self.assertEqual(client.get('/health').status_code,200)
            self.assertEqual(client.post('/transcribe',files={'audio':('a.wav',b'bad')}).status_code,401)
            self.assertEqual(client.post('/transcribe',headers={'Authorization':'Bearer internal-secret'},files={'audio':('a.wav',b'bad')}).status_code,415)
            self.assertEqual(client.post('/transcribe',headers={'Authorization':'Bearer internal-secret','Content-Length':str(module.MAX_BYTES+65537)},files={'audio':('a.wav',b'bad')}).status_code,413)

    def test_pcm_shape_and_duration_checked(self):
        buf=io.BytesIO()
        with wave.open(buf,'wb') as audio:
            audio.setnchannels(2);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(b'\x00'*160)
        with self.assertRaises(ValueError):module.inspect_wav(buf.getvalue())

    def test_analysis_uses_acoustics_without_running_transcription(self):
        from fastapi.testclient import TestClient
        class Model:
            def recognize(self,*args,**kwargs):
                raise AssertionError('Cleanup must not depend on ASR words')
            def analyze(self,path):
                return {'speech':[{'start':0.1,'end':0.5}], 'audible':[{'start':0.1,'end':0.8}]}
        buf=io.BytesIO()
        with wave.open(buf,'wb') as audio:
            audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(b'\x00'*32000)
        with TestClient(module.create_app(lambda:Model(),token='internal-secret')) as client:
            self.assertEqual(client.post('/analyze',files={'audio':('a.wav',buf.getvalue())}).status_code,401)
            response=client.post('/analyze',headers={'Authorization':'Bearer internal-secret'},files={'audio':('a.wav',buf.getvalue())})
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json()['speech'],[{'start':0.1,'end':0.5}])
            self.assertEqual(response.json()['audible'],[{'start':0.1,'end':0.8}])

if __name__=='__main__':unittest.main()
