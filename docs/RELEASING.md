# Releasing Relay

The public source repository is `RudreshNarwal/relay-recorder`. Develop community changes there through branches and pull requests. The earlier private investigation repository is an archive, not an upstream mirror to push automatically. Never merge its history into the public repository.

## License and source availability

Relay uses AGPL-3.0-only. Preserve license notices and provide the corresponding source required for distributed builds and modified network deployments. Publish the source matching each release, including build instructions and dependency lockfiles; do not point users of a modified deployment at an unrelated upstream version. Paid hosting and support do not remove these obligations. Third-party components keep their own terms.

## Source alpha

1. Start from a reviewed commit on `main`; ensure the CI checks pass for that commit.
2. Review the diff for secrets, private recordings, generated artifacts, and third-party code. Review dependency and asset licenses, and preserve required attribution. Run a secret scan against the release tree and its public history. Investigate findings without publishing sensitive scanner output.
3. Keep package and Mac marketing versions aligned. Apple bundle versions must remain valid numeric versions; an alpha suffix belongs on the Git tag and release title.
4. Reproduce the README setup on a fresh host. Record limitations and skipped hardware/provider checks. Do not present a source-only alpha as a notarized desktop release.
5. Create a GitHub prerelease for the reviewed tag, with supported platforms, setup instructions, validation evidence, and known limitations. Attach only verified artifacts and SHA-256 checksums.

Do not publish an install command until its package exists and has been tested. GitHub source archives exclude the private investigation history because the public repository starts from a reviewed source snapshot.

## macOS download

Enroll in the [Apple Developer Program](https://developer.apple.com/programs/enroll/). Create a [Developer ID Application certificate](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) and install it with its private key in your login Keychain. A Developer ID Installer certificate is for `.pkg` installers; Relay currently distributes a DMG containing an app.

Store notarization credentials interactively in Keychain:

```sh
xcrun notarytool store-credentials relay-notary
```

Do not put passwords, certificate exports, or private keys in the repository, issues, or chat. Then use the existing packaging script with your actual certificate identity:

```sh
RELAY_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAMID)' \
RELAY_NOTARY_PROFILE=relay-notary pnpm package:mac
```

The script signs the app, verifies its signature, creates a DMG, submits it for notarization, and staples tickets. Check the notarization log if any step fails. Test the downloaded DMG on a clean supported Mac, including Gatekeeper, capture permissions, recording, upload, playback, and interruption recovery. Complete the [hardware acceptance matrix](qa/macos-capture.md) before claiming those cases work.

Only after validation, attach the DMG and its checksum to the release. Do not recommend disabling Gatekeeper. Without signing credentials, keep distribution source-only and document the local ad-hoc build.

## Homebrew follow-up

Once a signed and notarized release download exists, create a separate `homebrew-tap` repository with a `relay-recorder` cask. Reference an immutable versioned release asset, its SHA-256 checksum, Apple Silicon support, and macOS 15+ requirements. Test a fresh install and upgrade before adding the command to the README. Homebrew installs the recorder; the server stack still needs its own deployment.

## Community settings

Enable Issues, Discussions, and private vulnerability reporting. Require successful CI before merging community changes. Keep workflow permissions minimal and never expose release/signing secrets to untrusted pull requests. Seed small, well-described issues and acknowledge contributors in release notes.

Enable a Sponsor button only after GitHub Sponsors enrollment or another funding account is approved. Paid hosted services and contracts require separate operational, pricing, and billing work; publishing this repository does not launch them.
