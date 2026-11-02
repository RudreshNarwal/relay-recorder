"""Explicit integration gate; requires cached/downloadable pinned models and speech WAV."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
import wave

@unittest.skipUnless(os.environ.get('ASR_LIVE_TEST') == '1', 'Set ASR_LIVE_TEST=1 for real model inference')
class LiveParakeetTests(unittest.TestCase):
    def test_real_speech_has_timed_words_and_silence_has_no_hallucination(self):
        spec=importlib.util.spec_from_file_location('relay_asr_live',Path(__file__).resolve().parents[1]/'services/asr/app.py')
        module=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        model=module.load_model()
        fixture=Path(os.environ['ASR_TEST_WAV'])
        with wave.open(str(fixture),'rb') as wav:
            duration=wav.getnframes()/wav.getframerate()
        segments=module.normalize_results(model.recognize(str(fixture),batch_size=1,max_speech_duration_s=20),duration)
        self.assertTrue(segments)
        self.assertTrue(all(segment.get('words') for segment in segments))
        self.assertTrue(all(0 <= segment['start'] < segment['end'] <= duration for segment in segments))
        self.assertIn(os.environ.get('ASR_EXPECT_TEXT','hello').lower(),' '.join(s['text'] for s in segments).lower())
        analysis=model.analyze(fixture)
        self.assertTrue(analysis['speech'])
        self.assertTrue(analysis['audible'])
        self.assertTrue(all(0 <= s['start'] < s['end'] <= duration for s in analysis['speech']))
        with tempfile.TemporaryDirectory() as directory:
            silence=Path(directory)/'silence.wav'
            with wave.open(str(silence),'wb') as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(b'\x00'*(16000*2*2))
            self.assertEqual(module.normalize_results(model.recognize(str(silence)),2),[])
            self.assertEqual(model.analyze(silence)['speech'],[])
            self.assertEqual(model.analyze(silence)['audible'],[])

if __name__=='__main__':unittest.main()
