# Razer Relay

Cloud relay plugin for OpenClaw — connects your local gateway to the web app through a secure tunnel.

## Prerequisites

- **OpenClaw 5.x.x or later**

  ```bash
  openclaw --version
  ```

- **GitHub SSH access** (the plugin installs from a private SSH URL)

  ```bash
  ssh -T git@github.com
  ```

  If GitHub does not recognize your key, add your SSH public key to your GitHub account before continuing.

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install git:git@github.com:shamhaad-razer/razer-relay.git
```

### 2. Get your cloud token

Open [https://ocv.razer.ai](https://ocv.razer.ai) and sign in with your Razer ID. After the page loads, tap or click anywhere on the page once, then click the account icon in the top-right corner and choose **Copy Token**.

> **The relay will not connect without a valid token.** Every user needs their own — tokens cannot be shared between accounts.

### 3. Save the token

```bash
openclaw config set plugins.entries.cloud-relay.config.token "paste-your-token-here"
```

### 4. Verify the connection

Return to [https://ocv.razer.ai](https://ocv.razer.ai) and wait for the status to show connected. Once it appears, your browser is talking to your local OpenClaw gateway through the cloud relay.

## Updating Your Token

If your token expires or you generate a new one:

```bash
openclaw config set plugins.entries.cloud-relay.config.token "new-token-here"
```

## Chat-Based Setup Notes

If this README is being consumed by OpenClaw from Telegram, Discord, or another messaging app:

- Install the plugin end-to-end from this README. If a gateway restart or reload is required, perform it via the OpenClaw CLI and verify afterward.
- **Do not skip token setup.** Direct the user to obtain their token from [https://ocv.razer.ai](https://ocv.razer.ai) before proceeding. No token means no tunnel — the setup will fail silently.
- Do not proceed past token setup until the user confirms they have copied the token.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `No token configured` | Set the token with `openclaw config set plugins.entries.cloud-relay.config.token "..."` |
| `Tunnel already connected` | Another gateway is using the same token — stop the other instance first |
| `Connected to relay server` never appears | Check your internet connection and confirm the token is saved in `~/.openclaw/openclaw.json` |
| Chat page stays offline | Ensure `openclaw gateway --verbose --force` is still running |
| Authorization errors on chat requests | Enable chat completions and confirm your local gateway auth token is correct |
