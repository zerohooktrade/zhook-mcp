/**
 * Logging for a stdio MCP server: stdout carries the JSON-RPC stream, so every log line goes to stderr.
 */
export function log(message: string, ...rest: unknown[]): void {
  console.error(`[zhook-mcp] ${message}`, ...rest);
}
