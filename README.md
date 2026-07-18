# varta-mcp

Spam classification MCP server for AI agents — built from real Telegram moderation data.

**Live at:** `https://mcp.getvarta.com/sse`  
**Get a free API key:** https://isitaspam.com/developers

## Tools

| Tool | Description |
|------|-------------|
| `check_spam_text` | Classify a message as SPAM / SUSPICIOUS / SAFE. Returns verdict, confidence (0–1), category, risk signals, red flags, and plain-language recommendation. |
| `get_spam_stats` | Daily spam classification statistics from isitaspam.com. |
| `get_spam_examples` | Five most recent public spam catches with links to full analysis. |

## Add to Claude Code

```bash
claude mcp add varta \
  --transport sse \
  https://mcp.getvarta.com/sse \
  --header "Authorization: Bearer varta_YOUR_KEY"
```

Get a free key (50 checks/day) at **https://isitaspam.com/developers** — instant, no credit card.

## Run locally (stdio)

The hosted server above is the easiest path. If you'd rather run the server as a
local process — or your MCP client only speaks stdio — use the bundled stdio entry
point. Same three tools, no dependencies, Node 18+.

```bash
git clone https://github.com/DarynaFor/mcp-varta.git
cd mcp-varta
API_KEY=varta_YOUR_KEY node src/stdio.js
```

Or wire it into a client config:

```json
{
  "mcpServers": {
    "varta": {
      "command": "node",
      "args": ["/path/to/mcp-varta/src/stdio.js"],
      "env": { "API_KEY": "varta_YOUR_KEY" }
    }
  }
}
```

`initialize` and `tools/list` work without a valid key, so registries and clients
can introspect the server before you have one.

## Example

```bash
curl -s -X POST https://mcp.getvarta.com/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer varta_YOUR_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "check_spam_text",
      "arguments": {
        "text": "Earn $5000/week from home! Click: bit.ly/abc123"
      }
    }
  }'
```

Response:
```
**Verdict: SPAM** (97% confidence)
**Category:** financial scam

**Why flagged:**
- Unrealistic income claim ($5000/week)
- Shortened URL hides real destination

**Recommended action:** Delete message and ban sender.

**Source:** isitaspam.com/check/financial_scam-earn-5000-week-a1b2c3d4
```

## How it works

The classifier runs 7-layer detection:
1. Fast pre-classifier (keyword + pattern signals)
2. Multi-LLM consensus (GPT + Claude + Gemini) for ambiguous cases
3. Vector similarity against 1,100+ verified scam patterns
4. URL safety check (Google Safe Browsing + PhishTank)
5. Crypto scam signal detection
6. Language detection (33 languages)
7. Stylometric analysis (urgency density, caps ratio, mixed-script patterns)

Data comes from **51 live Telegram groups protecting 29,000+ members** via [Varta](https://getvarta.com) — a Telegram anti-spam SaaS.

## Endpoints

| Endpoint | Transport |
|----------|-----------|
| `GET https://mcp.getvarta.com/sse` | SSE (Claude Code `--transport sse`) |
| `POST https://mcp.getvarta.com/mcp` | HTTP (`--transport http`) |
| `GET https://mcp.getvarta.com/` | Info / health check |

## Auth

Pass your API key as a Bearer token:

```
Authorization: Bearer varta_YOUR_KEY
```

**Free tier:** 50 checks/day  
**Paid tiers:** 2,000/day ($19/mo) · 10,000/day ($49/mo) — see https://isitaspam.com/developers#pricing

## Rate limits & errors

Rate limiting is applied by [isitaspam.com](https://isitaspam.com). On 429, the error body includes `reset_at` and `upgrade_url`.

| Code | Meaning |
|------|---------|
| `invalid_api_key` | Bearer token not recognised |
| `rate_limit_exceeded` | Daily or burst limit hit |
| `text_too_long` | Message exceeds 5,000 chars |

## REST API

If you prefer REST over MCP, the same keys work on [isitaspam.com/api/check](https://isitaspam.com/api/check) via `X-API-Key` header. Full OpenAPI 3.1 spec: https://isitaspam.com/openapi.yaml

## License

MIT
