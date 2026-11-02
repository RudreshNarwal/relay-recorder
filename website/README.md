# Relay website

Static marketing site for Relay at **https://relay.ideolyst.com**. It lives in the public `relay-recorder` repository, but deploys independently from the self-hosted application. Only `public/` is served. No application server, database, model download, framework build, or runtime package is required.

The website presents the public source alpha as an open-source alternative to Loom. The README and product documentation remain authoritative for installation, capabilities, and limitations. Do not advertise signed downloads or Homebrew until those artifacts exist and have been qualified.

## Preview and check

From the repository root, using Python 3.9+ and Node.js:

```sh
python3 website/check.py
node --check website/public/site.js
python3 -m http.server 4176 --bind 127.0.0.1 --directory website/public
```

Open http://127.0.0.1:4176. Stop the server with Ctrl-C. Check desktop and mobile widths, keyboard navigation, FAQs, and the copy button. The copy button requires a secure context (HTTPS or localhost); setup commands remain selectable when JavaScript or clipboard access is unavailable.

`python3 website/check.py` validates local links, anchors, accessible image attributes, social-card dimensions, canonical URL, sitemap, and the directory served by Wrangler. GitHub Actions runs these checks and JavaScript syntax validation without installing application dependencies.

To check Cloudflare's routing and response headers locally without authenticating or deploying:

```sh
cd website
npx wrangler@4.156.1 dev --local --port 4177
```

The ordinary Python server does not apply Cloudflare `_headers` or custom 404 routing; use Wrangler to verify those behaviors.

## Connect Cloudflare manually

Use the Cloudflare account containing the `ideolyst.com` zone and the existing TableIQ site. No AWS resources or CloudFront setup are needed.

1. Open **Workers & Pages → Create → Import a repository** (the wording may appear as **Connect to Git**). Choose `RudreshNarwal/relay-recorder`. If it is missing, extend the existing Cloudflare GitHub App installation to include this repository.
2. Create the Worker named **`relay-website`**, matching `wrangler.json`.
3. Set these build values:

   | Setting | Value |
   | --- | --- |
   | Production branch | `main` |
   | Root directory | `website` |
   | Build command | `python3 check.py && node --check public/site.js` |
   | Deploy command | `npx wrangler@4.156.1 deploy` |
   | Non-production deploy command, if requested | `npx wrangler@4.156.1 versions upload` |
   | Build watch paths, if offered | `website/**` |

4. Use Cloudflare's managed build credentials for this Worker. Do not paste an AWS key, expiring Wrangler OAuth token, or personal API token into the repository. There are no application environment variables to configure for this static site.
5. Deploy the production branch. `wrangler.json` declares **`relay.ideolyst.com` as a custom domain**; the deployment creates the Worker domain/DNS association and Cloudflare provisions HTTPS in the connected zone. If Cloudflare reports an existing DNS record or domain conflict, review that record before changing it. Do not replace unrelated records.
6. Verify the Worker under **Settings → Domains & Routes** and wait for the custom domain and certificate to become active. Confirm the production build belongs to the intended commit.

Cloudflare Workers Builds is the deployment CI, matching TableIQ. GitHub Actions is a separate validation check. No long-lived deployment secret needs to be copied into GitHub. Keep production on `main`; use non-production preview builds for branches. The Workers preview hostname receives `X-Robots-Tag: noindex`; the custom domain remains indexable.

If the account does not use Cloudflare as authoritative DNS for `ideolyst.com`, custom-domain creation will need the zone moved or another supported routing setup. The current TableIQ deployment uses the existing Cloudflare zone.

## Verify the live deployment

After the manual connection, check:

```sh
curl -I https://relay.ideolyst.com/
curl -I https://relay.ideolyst.com/this-page-does-not-exist
curl -fsS https://relay.ideolyst.com/robots.txt
```

Expect HTTPS 200 at the root, 404 for the missing page, and a sitemap pointing to `https://relay.ideolyst.com/sitemap.xml`. Open the site and verify images, setup links, FAQs, clipboard success/failure behavior, and mobile layout. Confirm the response includes the content security policy from `public/_headers`.

Set the GitHub repository's homepage URL once the custom domain serves the verified site. Submit the sitemap in search-engine webmaster tools if desired; publication does not guarantee indexing or rankings.

## Update and roll back

Edit files under `website/`, run the checks, and submit a focused pull request. GitHub runs **Website checks**; merging to `main` triggers the connected Cloudflare build. Application-only changes need not rebuild the website if the build watch path is configured.

For a website rollback, revert the website commit and let the production build run. Cloudflare's deployment rollback is also available for urgent recovery; reconcile the source branch afterward so the next build does not restore the unwanted change. Website deployment does not migrate the Relay application or touch recordings.

## Assets and privacy

The icon and banner are copies of the project's existing `docs/assets/` artwork. Update both locations when the identity changes. The timeline and comment are labeled illustrations, not product screenshots or performance evidence. No analytics, third-party scripts, external fonts, cookies, account forms, or email collection are included. Cloudflare may process ordinary request metadata under the site operator's hosting arrangement.
