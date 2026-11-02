# Third-party components and assets

AGPL-3.0-only applies to Relay's original code. Third-party components and assets retain their own licenses. This source release does not include the extracted application code or investigation corpus from any other product, installed dependencies, downloaded speech models, or signed application binaries.

## Bundled assets

| Asset | Source and terms |
| --- | --- |
| `services/worker/models/rnnoise-cb.rnnn` | RNNoise "conjoined-burgers" model from [arnndn-models](https://github.com/richardpl/arnndn-models/blob/0fda24c46d78f0207d820bb970fbe85c1971b39c/cb.rnnn), converted from [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models). The upstream README states the models are not subject to copyright. [Provenance and checksum](services/worker/models/README.md). |
| `services/worker/fixtures/connection.wav` | Synthetic speech fixture used for explicit provider connection tests; no customer recording is bundled. |
| `docs/assets/relay-icon.png` | Exported from Relay's own [icon drawing script](apps/macos/scripts/make-icon.swift). |
| `docs/assets/relay-banner.png` | AI-generated promotional illustration based on Relay's icon. It is not a screenshot of the application. |
| `docs/assets/badge-*.svg` | Project-authored documentation badges. |

## Speech software and downloaded models

- [FluidAudio](https://github.com/FluidInference/FluidAudio) is an Apache-2.0 Swift dependency pinned in `apps/macos/Package.resolved`. The packaging script includes its upstream LICENSE when present in the checkout.
- [onnx-asr](https://github.com/istupakov/onnx-asr) and its dependencies are installed from `services/asr/requirements.txt`; preserve their respective license notices when distributing environments or images.
- [Parakeet v3 ONNX](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx) and [Parakeet v3 Core ML](https://huggingface.co/FluidInference/parakeet-tdt-0.6b-v3-coreml) model cards identify CC-BY-4.0. The underlying model is [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3). Relay downloads converted model files at revisions pinned in its ASR source and Mac resource manifest; it does not bundle those weights in the source release.
- [Silero VAD ONNX](https://huggingface.co/istupakov/silero-vad-onnx) identifies the MIT license and derives from [Silero VAD](https://github.com/snakers4/silero-vad). Its revision is pinned in the ASR service.

Check the license and attribution files of the exact model revision before redistributing weights. Conversion or download through Relay does not replace upstream terms.

## Application and runtime dependencies

JavaScript dependencies and exact resolutions are recorded in `package.json` and `pnpm-lock.yaml`. After installation, inspect their declared production licenses with:

```sh
pnpm licenses list --prod
```

The current dependency inventory includes MIT, Apache-2.0, BSD, ISC, CC-BY-4.0, and other permissive terms, plus LGPL-licensed native libvips packages used by sharp. The package inventory is not a substitute for upstream notices or a binary distribution review.

FFmpeg is installed separately on hosts or into Docker images. Its applicable terms depend on the build configuration and enabled libraries. PostgreSQL, Python, Node.js, Caddy, Mailpit, container base images, and their bundled system components also retain upstream terms. A future binary/container release must review and satisfy the obligations of the actual distributed artifacts, including license texts, notices, and any applicable source obligations.

Provider APIs are external services governed by their own terms. An open-source client does not grant access to provider accounts, trademarks, or model services.
