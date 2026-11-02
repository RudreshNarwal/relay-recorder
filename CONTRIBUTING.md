# Contributing to Relay

Relay is an AGPL-3.0-only self-hosted video workspace and native macOS recorder. Contributions to code, documentation, accessibility, testing, and design are welcome. You do not need an invitation or repository write access to contribute.

## Find a place to start

- Browse [good first issues](https://github.com/RudreshNarwal/relay-recorder/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22good%20first%20issue%22) and [help wanted](https://github.com/RudreshNarwal/relay-recorder/issues?q=is%3Aissue%20is%3Aopen%20label%3A%22help%20wanted%22).
- Use [Discussions](https://github.com/RudreshNarwal/relay-recorder/discussions) for setup questions and early ideas. Use issues for reproducible bugs and concrete feature requests.
- Before a substantial change, describe the problem and proposed approach in an issue so maintainers can help confirm scope. Comment on a starter issue before beginning to avoid duplicate work.
- See the [roadmap](docs/ROADMAP.md) for current priorities. Report security concerns privately using [SECURITY.md](SECURITY.md).

## Set up a development environment

Fork the public repository, clone your fork, and create a branch from `main`. Follow the [README development instructions](README.md#development), using Node.js 24+ and pnpm 10.15.0. The server and web app can be developed without a Mac. Native recorder work requires Apple Silicon, macOS 15+, Swift 6.2+, and the macOS SDK.

Run commands from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Install FFmpeg and ffprobe for media tests. Tests requiring a database, live speech model, or external environment can be skipped by the default suite. A green default run does not prove those integrations. The CI integration job uses disposable PostgreSQL databases; see [worker validation](services/worker/VALIDATION.md#reproduction) for local reproduction. Never point integration tests at a production database or server.

For native changes:

```sh
swift test --package-path apps/macos
```

Real capture permissions, microphones, cameras, and signing need the [Mac acceptance checks](docs/qa/macos-capture.md). Synthetic tests do not replace hardware validation.

## Submit a pull request

Keep the change focused and explain the user-visible problem, the resulting behavior, and how you checked it. Add meaningful regression tests for behavior changes and update affected documentation. Include screenshots for visual changes, using synthetic data and no personal recordings. State which checks passed, failed, or were skipped.

Preserve original recordings, explicit provider consent, workspace access checks, and revision ownership. Do not add credentials, model downloads, generated app bundles, private recordings, or third-party source extracts to the repository. Include license and provenance information for new dependencies and assets.

Contributions are reviewed through pull requests. Maintainers may ask for changes or decline work outside the roadmap. Participation follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## License and credit

Unless explicitly stated otherwise, contributions you intentionally submit for inclusion are licensed under GNU AGPL version 3 only (`AGPL-3.0-only`). Only submit work you have the right to contribute, and retain required third-party notices. Contributors keep copyright in their contributions; no copyright assignment is required.

The existing core is available under AGPL-3.0-only. Optional paid hosting, setup, and support can fund maintenance without making community contributions dependent on a subscription.

No proprietary commercial license or contributor relicensing agreement is offered by this alpha. Any future dual-licensing proposal must address contributor rights explicitly; repository ownership alone does not grant the right to relicense others' contributions.
