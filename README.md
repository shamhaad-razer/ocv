
## Prerequisites

Before installing the plugin, please make sure your local setup is ready:

- **OpenClaw 5.x.x or later** is required.

  Check your version with:

  ```bash
  openclaw --version
  ```

- **GitHub SSH access** must be configured, because the plugin is installed from a private GitHub SSH URL.

  A quick check:

  ```bash
  ssh -T git@github.com
  ```

  If GitHub does not recognize your key yet, add your SSH public key to your GitHub account first. The plugin installer needs that little handshake before it can fetch the package.

## Quick Start

### 1. Install the plugin

Install the `cloud-relay` plugin:

```bash
openclaw plugins install git:git@github.com:shamhaad-razer/razer-relay.git
```

### Notes for chat-based setup

If this README is being used by OpenClaw from Telegram, Discord, or another configured messaging app, follow these notes after installing the plugin:

- Do **not** restart OpenClaw after the plugin finishes downloading. A restart is not required; continue directly with the token setup below.
- If the assistant does not tell the user where to copy the token, ask the user to open [https://opencl2.prp.razer.com](https://opencl2.prp.razer.com), sign in, then use the account menu in the top-right corner of the page and choose **Copy Token**.

### 2. Sign in and copy your cloud token

Open:

[https://opencl2.prp.razer.com](https://opencl2.prp.razer.com)

Sign up or log in with your Razer ID. After the page loads, tap or click anywhere on the page once. Then click the account icon on the top-right corner and choose **Copy Token**.

Keep that token handy. It is the little key that lets your local gateway find its cloud tunnel.

### 3. Save the token into OpenClaw config

Run:

```bash
openclaw config set plugins.entries.cloud-relay.config.token "paste-your-token-here"
```

### 4. Start OpenClaw gateway

Run:

```bash
openclaw gateway --verbose
```

If the tunnel connects successfully, you should see logs like:

```text
[plugins] [cloud-relay] Connected to relay server
[plugins] [cloud-relay] Tunnel established!
[plugins] [cloud-relay]   User:     yourname
[plugins] [cloud-relay]   Chat URL: https://opencl2.prp.razer.com/
```

### 5. Return to the web app

Return to:

[https://opencl2.prp.razer.com](https://opencl2.prp.razer.com)

Wait for the status is connected. Once it appears, your browser is talking to your local OpenClaw gateway through the cloud relay.

## Changing Your Token

If your token expires or you copy a new one, update it with:

```bash
openclaw config set plugins.entries.cloud-relay.config.token "new-token-here"
```

## Troubleshooting

- **`No token configured`**: Set the token with `openclaw config set plugins.entries.cloud-relay.config.token "paste-your-token-here"`.
- **`Tunnel already connected`**: Another gateway is already connected with the same token. Stop the other one first.
- **`Connected to relay server` does not appear**: Check your internet connection and confirm the token is saved in `~/.openclaw/openclaw.json`.
- **Chat page stays offline**: Make sure `openclaw gateway --verbose --force` is still running.
- **Chat request fails with authorization errors**: Enable chat completions and confirm your local gateway auth token is correct.
