---
summary: "CLI reference for `openclaw channels` (accounts, status, login/logout, logs)"
read_when:
  - You want to add/remove channel accounts (WhatsApp/Telegram/Discord/Google Chat/Slack/Mattermost (plugin)/Signal/iMessage)
  - You want to check channel status or tail channel logs
title: "channels"
---

# `openclaw channels`

Manage chat channel accounts and their runtime status on the Gateway.

Related docs:

- Channel guides: [Channels](/channels/index)
- Gateway configuration: [Configuration](/gateway/configuration)

## Common commands

```bash
openclaw channels list
openclaw channels status
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels logs --channel all
```

## Add / remove accounts

```bash
openclaw channels add --channel telegram --token <bot-token>
openclaw channels remove --channel telegram --delete
```

Tip: `openclaw channels add --help` shows per-channel flags (token, app token, signal-cli paths, etc).

## Login / logout (interactive)

```bash
openclaw channels login --channel whatsapp
openclaw channels logout --channel whatsapp
```

## Troubleshooting

- Run `openclaw status --deep` for a broad probe.
- Use `openclaw doctor` for guided fixes.
- `openclaw channels list` prints `Claude: HTTP 403 ... user:profile` → usage snapshot needs the `user:profile` scope. Use `--no-usage`, or provide a claude.ai session key (`CLAUDE_WEB_SESSION_KEY` / `CLAUDE_WEB_COOKIE`), or re-auth via Claude Code CLI.

## Capabilities probe

Fetch provider capability hints (intents/scopes where available) plus static feature support:

```bash
openclaw channels capabilities
openclaw channels capabilities --channel discord --target channel:123
```

Notes:

- `--channel` is optional; omit it to list every channel (including extensions).
- `--target` accepts `channel:<id>` or a raw numeric channel id and only applies to Discord.
- Probes are provider-specific: Discord intents + optional channel permissions; Slack bot + user scopes; Telegram bot flags + webhook; Signal daemon version; MS Teams app token + Graph roles/scopes (annotated where known). Channels without probes report `Probe: unavailable`.

## Resolve names to IDs

Resolve channel/user names to IDs using the provider directory:

```bash
openclaw channels resolve --channel slack "#general" "@jane"
openclaw channels resolve --channel discord "My Server/#support" "@someone"
openclaw channels resolve --channel matrix "Project Room"
```

Notes:

- Use `--kind user|group|auto` to force the target type.
- Resolution prefers active matches when multiple entries share the same name.

## Manage group allowlists

Control which groups/channels the bot can respond to using the `groups` subcommand. This is particularly useful for Delta.Chat, Telegram, and Slack channels that use allowlist-based group policies.

```bash
# List groups in the allowlist
openclaw channels groups list --channel deltachat

# Add a group to the allowlist
openclaw channels groups add --channel deltachat --group 16 --users "*"

# Add a group with specific users
openclaw channels groups add --channel deltachat --group 42 \
  --users "user1@example.com,user2@example.com" \
  --require-mention \
  --tools allow

# Update group settings
openclaw channels groups update --channel deltachat --group 16 \
  --require-mention \
  --tools deny

# Show group details
openclaw channels groups show --channel deltachat --group 16

# Remove a group from the allowlist
openclaw channels groups remove --channel deltachat --group 16
```

### Options

- `--channel <name>`: Channel to manage (deltachat, telegram, or slack). Defaults to deltachat.
- `--account <id>`: Account ID for multi-account setups. Defaults to the primary account.
- `--group <id>`: Group or chat ID (required for add/remove/update/show).
- `--users <list>`: Comma-separated list of allowed users. Use `*` to allow all users in the group.
- `--require-mention`: Require @mention to trigger the bot in this group.
- `--no-require-mention`: Don't require @mention (bot responds to all messages from allowed users).
- `--tools <policy>`: Tool access policy. Use `allow`, `deny`, or JSON like `{"allow":["tool1","tool2"]}`.
- `--json`: Output results as JSON.

### Notes

- Changes require a gateway restart to take effect: `openclaw daemon restart`
- For Delta.Chat, the group ID is the numeric chat ID visible in logs when messages are dropped
- For Telegram, use the chat ID (typically a negative number like `-100123456789`)
- For Slack, use the channel ID (typically starts with `C` like `C1234567890`)
- Use `openclaw pairing` for managing direct message (DM) allowlists

### Examples

**Delta.Chat**: After seeing `dropping message from group 16 (not in allowlist)` in logs:

```bash
# Add the group to the allowlist
openclaw channels groups add --channel deltachat --group 16 --users "*"

# Restart the gateway
openclaw daemon restart
```

**Telegram**: Restrict a group to specific users who must @mention the bot:

```bash
openclaw channels groups add --channel telegram \
  --group "-100123456789" \
  --users "123456,789012" \
  --require-mention
```

**Slack**: Allow a channel with tool restrictions:

```bash
openclaw channels groups add --channel slack \
  --group "C1234567890" \
  --users "*" \
  --tools '{"deny":["dangerous_tool"]}'
```
