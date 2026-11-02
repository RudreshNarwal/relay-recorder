# Relay roadmap

Relay is an early alpha. This roadmap states priorities, not delivery dates or promises. Use [Discussions](https://github.com/RudreshNarwal/relay-recorder/discussions) to share your workflow and [issues](https://github.com/RudreshNarwal/relay-recorder/issues) for scoped proposals.

## First: make the core workflow dependable

- Make clean-checkout setup repeatable on supported hosts.
- Qualify real Mac capture, permissions, interruption recovery, and upload resume.
- Validate playback, sharing revocation, revisions, and database/media restoration.
- Ship a Developer ID-signed and notarized Mac download, then a tested Homebrew cask.
- Improve onboarding, error messages, accessibility, and contribution documentation.

## Next: qualify existing capabilities

- Measure transcription and cleanup quality with consented, reproducible fixtures.
- Qualify external speech and delivery adapters with authorized accounts.
- Measure sustained recording, rendering, and storage requirements on documented hardware.

## Premium-capability gap work

The direction is to bring useful premium-style workflows into Relay's free self-hosted core. This is a development target, not a claim that every Loom feature ships today. The [dated comparison](LOOM-COMPARISON.md) records current support and remaining gaps.

1. **Qualify what exists.** Finish fresh-host setup and signed Mac distribution, then evaluate AI drafts, transcription, and cleanup on consented recordings. Exercise live providers and interruption/revocation paths. Exit with reproducible evidence and explicit quality limits, not fixture-only parity claims.
2. **Complete the AI handoff workflow.** Add opt-in visual/interaction context and reviewed developer diagnostics; add permission-aware MCP access and timestamp-cited video Q&A. Exit with source attribution, redaction/review controls, and the same workspace/video access checks as the app. These are currently missing capabilities, not current website claims.
3. **Expand capture and integrations.** Qualify browser/Windows capture before mobile; qualify existing connector OAuth, add destination discovery, and complete authorized meeting recording imports. Automatic meeting capture requires a separately qualified provider path and consent handling. Recap delivery needs explicit audience selection and duplicate-safe recovery.
4. **Close remaining editing and personalization gaps.** Add native rewind/background replacement and recipient-specific video variables only with clear original preservation, preview, and publication behavior. Personalized audio needs a consented voice/media design before implementation.
5. **Finish enterprise administration.** Add SSO/SCIM, configurable media retention, broader audit coverage, and Salesforce integration. Validate provisioning/revocation and retention recovery against isolated deployments. Managed hosting, uptime commitments, and compliance attestations require operational work beyond repository features.

No dates, vendor purchases, autonomous meeting runner, or voice-generation provider are selected by this list. Each item needs a bounded implementation and acceptance test before release. Infrastructure and optional AI-provider costs remain with the operator.

## Not committed for the alpha

Windows/mobile/browser recorders, autonomous meeting capture, SSO/SCIM, custom media retention, and hosted service availability are not promised by this release. Calendar connections do not imply an operational meeting recorder. See [current limitations](../README.md#current-limitations).

## Sustainability

The current core is AGPL-3.0-only licensed and usable without paying Relay. Optional paid hosting, installation assistance, and support may fund maintenance. No hosted plan, paid support SLA, or enterprise certification is offered by this alpha. Sponsorship links will be added when an actual funding account is available.
