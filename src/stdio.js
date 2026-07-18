#!/usr/bin/env node
/**
 * Varta MCP Server — stdio transport
 *
 * Same three tools as the hosted server at mcp.getvarta.com, but speaking MCP
 * over stdin/stdout so it can run locally (`npx`) or inside a container.
 *
 * Why this exists: the hosted server is a Cloudflare Worker and cannot be
 * "started" as a local process, so registries that verify a server by booting
 * it in Docker (e.g. Glama) had nothing to run. This entry point gives them a
 * real process to introspect, and gives users a local install option.
 *
 * Auth: API_KEY env var (same key as the hosted server — get one free at
 * https://isitaspam.com/developers). `initialize` and `tools/list` work without
 * a valid key so registries can introspect; only `tools/call` needs a real one.
 *
 * Zero dependencies — Node 18+ (global fetch).
 */

'use strict';

const ISITASPAM = 'https://isitaspam.com';
const MCP_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'varta', version: '1.0.0' };
const API_KEY = process.env.API_KEY || '';

// ─── Tool definitions (mirrors the hosted server) ────────────────────────────

const TOOLS = [
  {
    name: 'check_spam_text',
    description:
      'Classify a text message as SPAM, SUSPICIOUS, or SAFE using multi-LLM consensus (GPT + Claude + Gemini) and vector similarity against 1,100+ verified scam patterns. Returns verdict, confidence, category, risk signals, red flags, and plain-language recommendation. Built from real Telegram moderation data.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message text to classify. Max 5,000 characters.', maxLength: 5000 },
        locale: { type: 'string', description: "ISO 639-1 language hint (e.g. 'uk', 'ru', 'de'). Auto-detected if omitted." },
      },
      required: ['text'],
    },
  },
  {
    name: 'get_spam_stats',
    description:
      'Get daily spam classification statistics from isitaspam.com — total checks today, how many were classified as SPAM, how many as SUSPICIOUS. Cached 60 seconds.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_spam_examples',
    description:
      'Get the 5 most recent public spam/scam examples caught by the isitaspam.com classifier. Each result includes verdict, category, and a link to the full analysis.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// ─── Tool implementations ────────────────────────────────────────────────────

function textResult(text, isError = false) {
  return { isError, content: [{ type: 'text', text }] };
}

async function callCheckSpam(args) {
  if (!args || typeof args.text !== 'string' || !args.text.trim()) {
    return textResult('Error: "text" is required.', true);
  }
  const res = await fetch(`${ISITASPAM}/api/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
    body: JSON.stringify({ text: args.text, ...(args.locale ? { locale: args.locale } : {}) }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return textResult(`Error: ${data.message || data.error || `HTTP ${res.status}`}`, true);
  }

  const confidence = typeof data.confidence === 'number' ? (data.confidence * 100).toFixed(0) : '?';
  const category = String(data.category || 'unknown').replace(/_/g, ' ');
  const redFlags = Array.isArray(data.red_flags) ? data.red_flags : [];
  const whatToDo = Array.isArray(data.what_to_do) ? data.what_to_do.join(' ') : data.what_to_do || '';

  const lines = [
    `**Verdict: ${data.verdict}** (${confidence}% confidence)`,
    `**Category:** ${category}`,
    '',
    redFlags.length ? `**Why flagged:**\n${redFlags.map((f) => `- ${f}`).join('\n')}` : '',
    whatToDo ? `**Recommended action:** ${whatToDo}` : '',
    '',
    `**Source:** isitaspam.com/check/${data.slug}`,
  ].filter(Boolean);

  return textResult(lines.join('\n'));
}

async function callGetStats() {
  const res = await fetch(`${ISITASPAM}/api/stats`, { headers: { 'X-API-Key': API_KEY } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return textResult(`Error fetching stats: ${data.error || `HTTP ${res.status}`}`, true);

  return textResult(
    [
      '**isitaspam.com — Today\'s stats**',
      `Total classifications: ${data.total}`,
      `Spam detected: ${data.scams}`,
      `Suspicious: ${data.suspicious}`,
      `As of: ${data.as_of}`,
    ].join('\n')
  );
}

async function callGetExamples() {
  const res = await fetch(`${ISITASPAM}/api/recent`, { headers: { 'X-API-Key': API_KEY } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return textResult('Error fetching examples.', true);

  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) return textResult('No public examples yet.');

  return textResult(
    [
      '**Recent spam catches from isitaspam.com:**',
      '',
      ...items.map((item, i) => {
        const cat = String(item.category || 'unknown').replace(/_/g, ' ');
        return `${i + 1}. **${item.verdict}** — ${cat}\n   https://isitaspam.com/check/${item.slug}`;
      }),
    ].join('\n')
  );
}

// ─── JSON-RPC ────────────────────────────────────────────────────────────────

async function handleRpc(msg) {
  const { method, id, params } = msg;

  // initialize / tools/list stay auth-free so registries can introspect the
  // server with a dummy API_KEY (Glama boots it with e.g. {"API_KEY":"123"}).
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: { protocolVersion: MCP_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO } };
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (!API_KEY) {
      return { jsonrpc: '2.0', id, result: textResult('Error: API_KEY is not set. Get a free key at https://isitaspam.com/developers', true) };
    }
    try {
      let result;
      if (name === 'check_spam_text') result = await callCheckSpam(args);
      else if (name === 'get_spam_stats') result = await callGetStats();
      else if (name === 'get_spam_examples') result = await callGetExamples();
      else return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${name}` } };
      return { jsonrpc: '2.0', id, result };
    } catch (e) {
      return { jsonrpc: '2.0', id, result: textResult(`Error: ${e && e.message ? e.message : String(e)}`, true) };
    }
  }

  // Notifications carry no id and expect no response.
  if (typeof id === 'undefined') return null;
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ─── stdio transport (line-delimited JSON-RPC) ───────────────────────────────

function send(obj) {
  if (obj) process.stdout.write(JSON.stringify(obj) + '\n');
}

// Exit only once stdin is closed AND every in-flight request has answered —
// otherwise a tools/call still waiting on the network gets cut off mid-flight.
let pending = 0;
let stdinEnded = false;
function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    pending++;
    Promise.resolve(handleRpc(msg))
      .then(send)
      .catch((e) => {
        send({ jsonrpc: '2.0', id: msg && msg.id, error: { code: -32603, message: String(e) } });
      })
      .finally(() => {
        pending--;
        maybeExit();
      });
  }
});
process.stdin.on('end', () => {
  stdinEnded = true;
  maybeExit();
});
