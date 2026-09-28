# Security

## Reporting a vulnerability

Please report security problems privately through GitHub: open the repository's **Security** tab
and choose **Report a vulnerability**. Do not open a public issue for them. Say what an attacker
can do, what they need (for example a device on the same network, or a web page the user visits),
and how to reproduce it.

Only the latest release on `main` gets security fixes.

## What Model Duel is built for

Model Duel is a single-user app for a network you trust, such as your home or office. It runs on
one computer and talks to Unsloth Studio, LM Studio, cloud providers and, when you ask, a results
service. It keeps your machines' API keys, cloud API keys, a results-service token and a signing
key in its data folder.

It protects against:

- **Other devices on your network**, once you set `DUEL_PASSWORD`: every route but the health
  check needs a signed session cookie, and repeated wrong passwords are slowed down. Without a
  password, keep the app on this computer only, which is the default for both `npm start` and
  Docker.
- **Web pages you visit**: requests addressed to unknown host names are refused (DNS rebinding),
  requests that change anything are refused when the browser says another site made them, the
  session cookie is SameSite=Strict, and a strict Content-Security-Policy stops other sites framing
  the page.
- **Keys going astray**: keys never reach the browser, the logs, result files or exports, and a
  saved key goes only to the address it was saved with.
- **Hostile or broken servers**: answers from machines, providers and the results service are read
  with size limits, never rendered as HTML, and kept out of spreadsheet formulas and Markdown
  markup in exports.

It does not protect against:

- **Someone who can read your network traffic.** The app, Unsloth and LM Studio speak plain HTTP on
  your network, so passwords and API keys can be read in transit there. For access from outside,
  use a VPN or put the app behind an HTTPS reverse proxy.
- **Someone who can read the data folder** or runs code as your user: keys are stored readable by
  your user only (mode 600), not encrypted.
- **The machines themselves.** Model Duel sends load options, including extra llama.cpp arguments,
  to the machines you add; whoever can use the app can use them. Add only servers you control.

## Keeping it safe

- Set `DUEL_PASSWORD` before opening the app to your network, and use a long one.
- Keep Node.js (22.23.2 or newer), Docker and the app up to date. Dependabot proposes updates to
  npm packages, the Node image and the CI actions, and CI runs `npm audit` and CodeQL.
- `npm run smoke` checks a running install's security settings: headers, host and cross-site
  refusals, the password, and that no key shows.
