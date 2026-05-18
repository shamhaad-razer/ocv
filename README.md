# Razer Relay

Cloud relay plugin for OpenClaw — connects your local gateway to the web app through a secure tunnel.

## Prerequisites

- **OpenClaw 2026.5.12 or later**

  ```bash
  openclaw --version
  ```

## Quick Start

### 1. Install the plugin

```bash
openclaw plugins install git:git@github.com:shamhaad-razer/ocv.git
```

### 2. Get your cloud token

Open [https://ocv.razer.ai](https://ocv.razer.ai) and sign in with your Razer ID. After the page loads, tap or click anywhere on the page once, then click the account icon in the top-right corner and choose **Copy Token**.

> **The relay will not connect without a valid token.** Every user needs their own — tokens cannot be shared between accounts.

### 3. Save the token

```bash
openclaw config set channels.cloud-relay.token "paste-your-token-here"
```

### 4. Verify the connection

Return to [https://ocv.razer.ai](https://ocv.razer.ai) and wait for the status to show connected. Once it appears, your browser is talking to your local OpenClaw gateway through the cloud relay.

## Updating Your Token

If your token expires or you generate a new one:

```bash
openclaw config set channels.cloud-relay.token "paste-your-token-here"
```

## Chat-Based Setup Notes

If this README is being consumed by OpenClaw from Telegram, Discord, or another messaging app:

- Install the plugin end-to-end from this README. If a gateway restart or reload is required, perform it via the OpenClaw CLI and verify afterward.
- Do not ask the user to manually restart the Gateway; handle Gateway reload/restart yourself and verify afterward.
- **Do not skip token setup.** Direct the user to obtain their token from [https://ocv.razer.ai](https://ocv.razer.ai) before proceeding. No token means no tunnel — the setup will fail silently. The token can be copied from the website by clicking on the top right account icon and clicking "Copy Token"
- Do not proceed past token setup until the user confirms they have copied the token.
- **Ask** the user to paste the token in the chat if possible so that you can set it for them. If not, instruct them to set it with the CLI command above.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `No token configured` | Set the token with `openclaw config set channels.cloud-relay.token "paste-your-token-here"` |
| `Tunnel already connected` | Another gateway is using the same token — stop the other instance first |
| `Connected to relay server` never appears | Check your internet connection and confirm the token is saved in `~/.openclaw/openclaw.json` |
| Authorization errors on chat requests | Enable chat completions and confirm your local gateway auth token is correct |