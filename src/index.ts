/**
 * Varta MCP Server — mcp.getvarta.com
 *
 * Exposes 3 tools for AI agents:
 *   check_spam_text   — classify a message via isitaspam.com
 *   get_spam_stats    — daily classification stats
 *   get_spam_examples — recent public spam catches
 *
 * Auth: Authorization: Bearer varta_* (same key issued at isitaspam.com/developers)
 * Forwarded as X-API-Key header to isitaspam.com — rate limits applied there.
 *
 * Supports both transports:
 *   SSE   — GET /sse  +  POST /messages
 *   HTTP  — POST /mcp
 */

import { Hono } from "hono";
import { cors } from "hono/cors";

const ISITASPAM = "https://isitaspam.com";
const MCP_VERSION = "2024-11-05";
const SERVER_INFO = { name: "varta", version: "1.0.0" };

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "check_spam_text",
    description:
      "Classify a text message as SPAM, SUSPICIOUS, or SAFE using multi-LLM consensus (GPT + Claude + Gemini) and vector similarity against 1,100+ verified scam patterns. Returns verdict, confidence, category, risk signals, red flags, and plain-language recommendation. Built from real Telegram moderation data — 51 groups, 29K+ members.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "Message text to classify. Max 5,000 characters.",
          maxLength: 5000,
        },
        locale: {
          type: "string",
          description: "ISO 639-1 language hint (e.g. 'uk', 'ru', 'de'). Auto-detected if omitted.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "get_spam_stats",
    description:
      "Get daily spam classification statistics from isitaspam.com — total checks today, how many were classified as SPAM, how many as SUSPICIOUS. Cached 60 seconds.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "get_spam_examples",
    description:
      "Get the 5 most recent public spam/scam examples caught by the isitaspam.com classifier. Each result includes verdict, category, and a link to the full analysis. Useful for showing users what active scam patterns look like.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ─── Tool implementations ─────────────────────────────────────────────────────

async function callCheckSpam(args: { text: string; locale?: string }, apiKey: string) {
  const res = await fetch(`${ISITASPAM}/api/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({ text: args.text, ...(args.locale ? { locale: args.locale } : {}) }),
  });

  const data = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    const msg = (data.message as string) || (data.error as string) || `HTTP ${res.status}`;
    return { isError: true, content: [{ type: "text" as const, text: `Error: ${msg}` }] };
  }

  const verdict = data.verdict as string;
  const confidence = ((data.confidence as number) * 100).toFixed(0);
  const category = (data.category as string || "unknown").replace(/_/g, " ");
  const slug = data.slug as string;
  const redFlags = (data.red_flags as string[]) || [];
  const whatToDo = Array.isArray(data.what_to_do)
    ? (data.what_to_do as string[]).join(" ")
    : (data.what_to_do as string) || "";

  const lines = [
    `**Verdict: ${verdict}** (${confidence}% confidence)`,
    `**Category:** ${category}`,
    "",
    redFlags.length > 0 ? `**Why flagged:**\n${redFlags.map((f) => `- ${f}`).join("\n")}` : "",
    whatToDo ? `**Recommended action:** ${whatToDo}` : "",
    "",
    `**Source:** isitaspam.com/check/${slug}`,
  ].filter(Boolean);

  return {
    isError: false,
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

async function callGetStats(apiKey: string) {
  const res = await fetch(`${ISITASPAM}/api/stats`, {
    headers: { "X-API-Key": apiKey },
  });
  const data = await res.json() as Record<string, unknown>;

  if (!res.ok) {
    return { isError: true, content: [{ type: "text" as const, text: `Error fetching stats: ${data.error}` }] };
  }

  const text = [
    `**isitaspam.com — Today's stats**`,
    `Total classifications: ${data.total}`,
    `Spam detected: ${data.scams}`,
    `Suspicious: ${data.suspicious}`,
    `As of: ${data.as_of}`,
  ].join("\n");

  return { isError: false, content: [{ type: "text" as const, text }] };
}

async function callGetExamples(apiKey: string) {
  const res = await fetch(`${ISITASPAM}/api/recent`, {
    headers: { "X-API-Key": apiKey },
  });
  const data = await res.json() as { items?: Array<{ slug: string; verdict: string; category: string }> };

  if (!res.ok) {
    return { isError: true, content: [{ type: "text" as const, text: "Error fetching examples." }] };
  }

  const items = data.items || [];
  if (items.length === 0) {
    return { isError: false, content: [{ type: "text" as const, text: "No public examples yet." }] };
  }

  const lines = [
    "**Recent spam catches from isitaspam.com:**",
    "",
    ...items.map((item, i) => {
      const cat = (item.category || "unknown").replace(/_/g, " ");
      return `${i + 1}. **${item.verdict}** — ${cat}\n   https://isitaspam.com/check/${item.slug}`;
    }),
  ];

  return { isError: false, content: [{ type: "text" as const, text: lines.join("\n") }] };
}

// ─── JSON-RPC dispatcher ──────────────────────────────────────────────────────

function makeError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handleRpc(body: Record<string, unknown>, apiKey: string | null): Promise<unknown> {
  const { method, id, params } = body as {
    method: string;
    id: unknown;
    params?: Record<string, unknown>;
  };

  // Methods that don't require auth
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      },
    };
  }

  if (method === "notifications/initialized") {
    return null; // notification — no response needed
  }

  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  // Methods that require auth
  if (method === "tools/call") {
    if (!apiKey) {
      return makeError(id, -32001, "Authorization required. Pass Bearer token: claude mcp add varta --transport sse https://mcp.getvarta.com/sse --header 'Authorization: Bearer varta_YOUR_KEY'");
    }

    const toolName = (params?.name as string) || "";
    const toolArgs = (params?.arguments as Record<string, unknown>) || {};

    if (toolName === "check_spam_text") {
      if (!toolArgs.text) return makeError(id, -32602, "Missing required argument: text");
      const result = await callCheckSpam(toolArgs as { text: string; locale?: string }, apiKey);
      return { jsonrpc: "2.0", id, result };
    }

    if (toolName === "get_spam_stats") {
      const result = await callGetStats(apiKey);
      return { jsonrpc: "2.0", id, result };
    }

    if (toolName === "get_spam_examples") {
      const result = await callGetExamples(apiKey);
      return { jsonrpc: "2.0", id, result };
    }

    return makeError(id, -32601, `Unknown tool: ${toolName}`);
  }

  return makeError(id, -32601, `Unknown method: ${method}`);
}

// ─── Hono app ─────────────────────────────────────────────────────────────────

const app = new Hono();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));

function extractBearer(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

// ─── GET /sse — SSE transport handshake ──────────────────────────────────────
// Claude Code connects here, receives the POST endpoint URL, then sends requests
// to POST /messages. We respond to POST /messages directly (in POST body).
app.get("/sse", async (c) => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const write = (data: string) => writer.write(enc.encode(data));

  // Immediately send the endpoint event — Claude Code reads this to know where to POST
  c.executionCtx.waitUntil(
    (async () => {
      await write("event: endpoint\ndata: /messages\n\n");
      // Keep alive with heartbeats — Workers time out after ~30s of no activity
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 25000));
        await write(": heartbeat\n\n");
      }
      writer.close();
    })()
  );

  return new Response(readable as unknown as ReadableStream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

// ─── POST /messages — SSE transport RPC ──────────────────────────────────────
app.post("/messages", async (c) => {
  const apiKey = extractBearer(c.req.header("Authorization"));
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(makeError(null, -32700, "Parse error"), 400); }

  const response = await handleRpc(body, apiKey);
  if (response === null) return c.body(null, 202); // notification — no content
  return c.json(response);
});

// ─── POST /mcp — HTTP transport (alternative) ────────────────────────────────
app.post("/mcp", async (c) => {
  const apiKey = extractBearer(c.req.header("Authorization"));
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json(makeError(null, -32700, "Parse error"), 400); }

  const response = await handleRpc(body, apiKey);
  if (response === null) return c.body(null, 202);
  return c.json(response);
});

// ─── GET / — info page ───────────────────────────────────────────────────────
app.get("/", (c) =>
  c.json({
    name: "Varta MCP Server",
    version: "1.0.0",
    tools: TOOLS.map((t) => t.name),
    sse_endpoint: "https://mcp.getvarta.com/sse",
    http_endpoint: "https://mcp.getvarta.com/mcp",
    auth: "Authorization: Bearer varta_YOUR_KEY",
    get_key: "https://isitaspam.com/developers",
    install: "claude mcp add varta --transport sse https://mcp.getvarta.com/sse --header 'Authorization: Bearer varta_YOUR_KEY'",
  })
);

export default app;
