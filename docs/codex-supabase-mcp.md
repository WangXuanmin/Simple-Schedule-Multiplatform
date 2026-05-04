# Codex Supabase MCP

## Purpose

Connect Codex to the Supabase project so future database inspection and
Supabase-aware development can happen through MCP.

## Project

```text
Project ref:
vzojfajfpjdjeoavhtks

MCP URL:
https://mcp.supabase.com/mcp?project_ref=vzojfajfpjdjeoavhtks
```

## Setup Commands

Add the Supabase MCP server:

```bash
codex mcp add supabase --url https://mcp.supabase.com/mcp?project_ref=vzojfajfpjdjeoavhtks
```

Enable remote MCP client support in `~/.codex/config.toml`:

```toml
[mcp]
remote_mcp_client_enabled = true
```

Authenticate:

```bash
codex mcp login supabase
```

Verify inside Codex:

```text
/mcp
```

## Current Status

Configured in `~/.codex/config.toml`:

```toml
[mcp]
remote_mcp_client_enabled = true

[mcp_servers.supabase]
url = "https://mcp.supabase.com/mcp?project_ref=vzojfajfpjdjeoavhtks"
```

Still needed:

```bash
codex mcp login supabase
```

In this Codex desktop shell, `codex.exe` returned `Access is denied`, so the
login command needs to be run from a terminal where the Codex CLI is directly
executable, or through Codex's own MCP authentication UI if available.

## Optional Supabase Agent Skills

```bash
npx skills add supabase/agent-skills
```

This is optional. The project can continue without it.
