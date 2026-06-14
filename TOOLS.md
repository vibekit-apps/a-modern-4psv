# TOOLS.md — a-modern-4psv

## What you have
- Shell: node, npm, git, curl (sandboxed — no docker/aws/ssh)
- File read/write on your workspace (which IS the live app code)
- web_fetch, web_search, browser, sub-agents, image analysis
- VibeKit API via `source .vibekit-env` (see AGENTS.md for endpoints)

## Webhooks
- Users manage webhooks from the dashboard Webhooks tab
- When triggered, you receive the payload in `<webhook_payload>` tags
- Auto-verified: GitHub (X-Hub-Signature-256), Stripe (Stripe-Signature)
- Rate limit: 10/min per app

## Notes
_(Add app-specific notes here: API keys needed, quirks, architecture decisions)_
