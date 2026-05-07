# OpenClaw Cloud Relay Plugin

Connect your local OpenClaw gateway to the cloud so others can chat with your AI through a browser.

## Getting Started

### 1. Create an account

Visit [https://opencl2.prp.razer.com](https://opencl2.prp.razer.com) and sign up with a username and password.

### 2. Copy your token

After signing in, click your **username** in the top-right corner and select **Copy Token**.

### 3. Install OpenClaw (skip if already installed)

```bash
# Check if you already have it
openclaw --version

# If not installed:
npm install -g openclaw
```

### 4. Set up the gateway (skip if already onboarded)

```bash
# Check if you already have a config
ls ~/.openclaw/openclaw.json

# If not set up yet:
openclaw onboard --non-interactive --accept-risk --mode local --skip-health \
  --auth-choice openai-api-key --openai-api-key "sk-proj-your-openai-key"
```

### 5. Install the cloud-relay plugin

```bash
# Unzip the plugin somewhere, then:
openclaw plugins install /path/to/cloud-relay
```

### 6. Configure

```bash
openclaw config set plugins.entries.cloud-relay.config.token "paste-your-token-here"
openclaw config set gateway.http.endpoints.chatCompletions.enabled true --strict-json
```

### 7. Start

```bash
openclaw gateway --verbose --force
```

You should see:
```
[cloud-relay] Tunnel established!
[cloud-relay]   User:     yourname
[cloud-relay]   Chat URL: https://opencl2.prp.razer.com/chat/yourname
```

Open the Chat URL in your browser and start chatting.

## Changing your token

No restart needed — just run:

```bash
openclaw config set plugins.entries.cloud-relay.config.token "new-token"
```

The plugin picks up the change automatically within 5 seconds.

## Troubleshooting

- **"No token configured"** — Run step 6 above to set your token.
- **"Tunnel already connected"** — Another instance is running with the same token. Stop it first.
- **401 on chat** — Make sure you ran `openclaw config set gateway.http.endpoints.chatCompletions.enabled true --strict-json`.
- **Gateway not found** — Make sure `openclaw gateway --verbose --force` is running.
