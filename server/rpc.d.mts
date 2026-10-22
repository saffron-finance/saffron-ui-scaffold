import type { IncomingMessage, ServerResponse } from 'node:http'

/** Server-only middleware shared by the production server and Vite development. */
export function createRpcHandler(options?: { root?: string; basePath?: string }):
  (request: IncomingMessage, response: ServerResponse) => Promise<boolean>
