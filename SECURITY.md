# Security policy

Relay is an early alpha that processes private recordings, transcripts, authentication data, and optional provider credentials. No independent security audit or production service-level guarantee is claimed.

## Report a vulnerability privately

Use [GitHub's private vulnerability reporting form](https://github.com/RudreshNarwal/relay-recorder/security/advisories/new). Do not open a public issue with an exploit, credential, private recording, or sensitive reproduction data. If the form is unavailable, wait for a private reporting channel rather than disclosing details publicly.

Include the affected version or commit, deployment mode, expected behavior, observed impact, and the smallest reproduction using synthetic data. Never test another person's deployment without permission. Do not send production database dumps or provider API keys.

The maintainer will assess reports and coordinate fixes and disclosure. This volunteer project does not promise a response deadline or offer a paid bug bounty.

## Supported versions

During alpha, fixes target the latest prerelease and `main`. Older alpha releases do not receive a separate maintenance branch. Review release notes before upgrading and back up database, media, and encryption keys.

## Deployment responsibilities

Follow the [deployment guide](docs/DEPLOYMENT.md). Use HTTPS and real email delivery on public hosts. Keep PostgreSQL, ASR, media storage, credentials, and backups private. Default development settings are not a public production deployment. Keep dependencies and container images updated, and review access before connecting external providers.
