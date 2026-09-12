import { TOOL_LIST, callTool, type ToolEnvironment } from "./tools";

/**
 * The MCP wire, by hand.
 *
 * MCP over Streamable HTTP is JSON-RPC 2.0 in a POST body. This server has no
 * resources, no prompts, no sampling and nothing it ever pushes at a client,
 * so the whole protocol surface is five methods and one response shape. The
 * official SDK would be a runtime dependency and a server abstraction for
 * about eighty lines of dispatch — the repo is deliberately at ten runtime
 * dependencies, and this is not the eleventh.
 *
 * A single JSON response is returned rather than an SSE stream: SSE exists so
 * a server can interleave its own requests with a reply, and this one never
 * has anything to interleave. The specification allows either.
 */

const SERVER = { name: "viva", title: "VIVA", version: "0.1.0" } as const;

/** Versions this server answers to. Anything else is answered in the newest. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST = PROTOCOL_VERSIONS[0];

const INSTRUCTIONS =
  "VIVA is the study app the student talks to. Their subjects, their map and their notes live in their VIVA account, so connect once with connect_my_viva_account before anything else. Let VIVA ask and mark the questions — it marks against the student's own material and it is the only thing that moves their map. Quote what VIVA quotes; do not add material their source does not have.";

export type JsonRpcId = string | number | null;

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
};

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function versionFor(params: unknown): string {
  const asked = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
  return typeof asked === "string" && PROTOCOL_VERSIONS.includes(asked) ? asked : LATEST;
}

/**
 * Handle one JSON-RPC message. `null` means the message was a notification or
 * a response — nothing goes back on the wire for those.
 */
export async function handleMessage(message: unknown, env: ToolEnvironment): Promise<JsonRpcResponse | null> {
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return fail(null, INVALID_REQUEST, "Expected a JSON-RPC request object.");
  }
  const { id, method, params } = message as { id?: JsonRpcId; method?: unknown; params?: unknown };
  if (typeof method !== "string") {
    // A response coming back at us, not a request. Nothing to answer.
    return id === undefined ? null : fail(id ?? null, INVALID_REQUEST, "Expected a method.");
  }
  const isNotification = id === undefined || id === null;
  const requestId: JsonRpcId = id ?? null;

  switch (method) {
    case "initialize":
      return ok(requestId, {
        protocolVersion: versionFor(params),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER,
        instructions: INSTRUCTIONS,
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return isNotification ? null : ok(requestId, {});

    case "tools/list":
      return ok(requestId, { tools: TOOL_LIST });

    case "tools/call": {
      const call = params as { name?: unknown; arguments?: unknown } | null;
      if (typeof call?.name !== "string") {
        return fail(requestId, INVALID_REQUEST, "tools/call needs the name of a tool.");
      }
      try {
        const outcome = await callTool(call.name, call.arguments, env);
        // A tool that refused is a result, not a protocol error: the model has
        // to be able to read what went wrong and try something else.
        return ok(requestId, { content: [{ type: "text", text: outcome.text }], isError: outcome.isError });
      } catch {
        return fail(requestId, INTERNAL_ERROR, "That tool did not finish.");
      }
    }

    default:
      return isNotification ? null : fail(requestId, METHOD_NOT_FOUND, `This server does not implement ${method}.`);
  }
}

/** One POST body: a single message, or a batch of them. */
export async function handleBody(body: unknown, env: ToolEnvironment): Promise<JsonRpcResponse[]> {
  const messages = Array.isArray(body) ? body : [body];
  if (messages.length === 0) return [fail(null, INVALID_REQUEST, "Empty batch.")];
  const answers = await Promise.all(messages.map((m) => handleMessage(m, env)));
  return answers.filter((a): a is JsonRpcResponse => a !== null);
}

export const RPC_ERRORS = { PARSE_ERROR, INVALID_REQUEST, METHOD_NOT_FOUND, INTERNAL_ERROR };

export function parseError(): JsonRpcResponse {
  return fail(null, PARSE_ERROR, "That was not JSON.");
}
