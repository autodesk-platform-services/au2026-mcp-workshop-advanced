# Part 2: Streamable HTTP

In this section you'll replace the STDIO transport from the beginner session with **Streamable HTTP**. The MCP server becomes a real network service that runs once and accepts connections from any MCP client over the network. Authentication stays 2-legged for now — the user-level OAuth flow comes in Part 3 once the transport groundwork is in place.

## Theory

### STDIO vs. Streamable HTTP

The beginner server used STDIO: VS Code launched `node index.js` as a child process and spoke JSON-RPC over its stdin/stdout. That works beautifully for local development but has three big limitations: only one client can talk to one process, the lifetime is tied to the editor, and there's no way to bolt on a web flow (like an OAuth redirect) because nothing is listening on a port.

`createMcpHandler` from `@modelcontextprotocol/server`, adapted to Express with `toNodeHandler` from `@modelcontextprotocol/node`, fixes all three. The server runs independently, and clients `POST` JSON-RPC messages to a single endpoint (we'll use `/mcp`).

### One handler, one factory

`createMcpHandler` takes a single argument: a factory function it calls to build an `McpServer`. Handing it `() => createMcpServer(authenticationProvider)` is enough — tools and resources close over whatever the factory received, so every `McpServer` it builds comes out fully wired without you touching a transport object, a session map, or a `crypto.randomUUID()` call. `createMcpHandler` manages the protocol-level request/response bookkeeping internally, whatever that turns out to require for a given client.

That works here because the *auth provider* is shared, not per-client: one `AppAuthenticationProvider` covers the whole process because every 2-legged token represents the application itself, not any particular user. In Part 3 you'll swap it for a `UserAuthenticationProvider` holding real user tokens — but you'll keep it just as shared, a workshop simplification Part 3 explains in detail. Because the factory is the only moving part, the beginner's `mcp.js` needs no changes at all to work under this transport.

## Step 1: Keep the MCP factory unchanged

`mcp.js` from the beginner workshop already returns an `McpServer` built around an injected auth provider. No changes needed in this step — the same factory works under both transports.

If you have not copied it across yet, this is what it should look like:

```js
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHubsProjects, getFolderContents } from './aps.js';

export function createMcpServer(authenticationProvider) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        description: 'MCP server for Autodesk Platform Services',
        version: '1.0.0'
    });

    server.registerTool(
        'list-hubs-projects',
        {
            description: 'Lists all hubs and their projects available to the APS application.',
        },
        async () => {
            const hubs = await getHubsProjects(authenticationProvider);
            return { content: [{ type: 'text', text: JSON.stringify(hubs, null, 2) }] };
        }
    );

    server.registerTool(
        'list-folder-contents',
        {
            description: 'Lists the contents of a folder in a project, or top-level folders if no folder ID is provided.',
            inputSchema: z.object({
                hubId: z.string().describe('Hub ID.'),
                projectId: z.string().describe('Project ID.'),
                folderId: z.string().optional().describe('Folder ID. Omit to list top-level folders.'),
            })
        },
        async ({ hubId, projectId, folderId }) => {
            const items = await getFolderContents(hubId, projectId, folderId, authenticationProvider);
            return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }
    );

    return server;
}
```

## Step 2: Rewrite the entry point

Replace `index.js` with the HTTP-based version:

```js
import cors from 'cors';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { AppAuthenticationProvider } from './aps.js';
import { createMcpServer } from './mcp.js';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    console.error('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.');
    process.exit(1);
}
const PORT = parseInt(process.env.PORT || '3000');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;

const authenticationProvider = new AppAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET);
const mcpHandler = createMcpHandler(() => createMcpServer(authenticationProvider));

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.use(cors());

const mcpNodeHandler = toNodeHandler(mcpHandler);
app.all('/mcp', (req, res) => mcpNodeHandler(req, res, req.body));

app.listen(PORT, () => console.log(`MCP server listening on ${PUBLIC_URL}/mcp`));
```

What's happening:

- `createMcpExpressApp` (from `@modelcontextprotocol/express`) is an Express app pre-configured for MCP servers — it applies `express.json()` for you. Mount your own middleware on it — we add `cors()` so browser-based clients can reach the endpoint.
- `createMcpHandler` (from `@modelcontextprotocol/server`) wraps your factory into a framework-agnostic MCP request handler. `toNodeHandler` (from `@modelcontextprotocol/node`) adapts that handler's web-standard `fetch` interface to the `(req, res)` shape Express expects.
- Because `createMcpExpressApp` already parsed the request body via `express.json()`, forward it explicitly: `mcpNodeHandler(req, res, req.body)`. Without that third argument the handler would try to read the request stream itself and find it already drained.
- `app.all('/mcp', ...)` is the entire route: every request, of any method, goes through the same handler. There's no session header to inspect and no branching on `initialize` versus everything else — `createMcpHandler` works that out from the request itself.
- Errors inside a tool handler, or a malformed request, are already turned into a proper JSON-RPC error response by `createMcpHandler` — there's no `try`/`catch` to write here.

> **"Binding to 0.0.0.0 without DNS rebinding protection" warning.** `createMcpExpressApp({ host: '0.0.0.0' })` prints this to `stderr` on startup — it's expected here, not an error. Codespace port forwarding needs the server listening on all interfaces, and the warning is just the SDK reminding you that host/origin checks are off outside `localhost`. The [Extras](extras.md) production checklist covers locking this down for a real deployment.

> **Public URL.** `PUBLIC_URL` is unused right now but worth threading through — Part 3 needs it for the OAuth callback and Part 4 needs it for the viewer's CSP.

## Step 3: Update the VS Code integration

`.vscode/mcp.json` from the beginner session pointed at a STDIO command. Replace it with an HTTP entry:

```json
{
  "servers": {
    "APS MCP Server (Advanced)": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

When VS Code connects, it issues a `POST` to `/mcp` to initialize the connection, and every later message from Copilot goes to that same endpoint.

## Step 4: Add a debug launch configuration

`npm start` runs the server, but it gives you no breakpoints. Add `.vscode/launch.json` so you can start the server under VS Code's Node debugger instead:

```json
{
    // Use IntelliSense to learn about possible attributes.
    // Hover to view descriptions of existing attributes.
    // For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387
    "version": "0.2.0",
    "configurations": [
        {
            "type": "node",
            "request": "launch",
            "name": "Launch MCP Server",
            "skipFiles": [
                "<node_internals>/**"
            ],
            "program": "${workspaceFolder}/index.js",
            "envFile": "${workspaceFolder}/.env"
        }
    ]
}
```

Press <kbd>F5</kbd> (or pick **Launch MCP Server** in the **Run and Debug** panel) to start the server with the debugger attached. Breakpoints in `index.js`, `mcp.js`, and `aps.js` all hit, which is far more useful than `console.log` once Part 3 adds an OAuth flow with several redirects.

> **The `envFile` line.** It loads `APS_CLIENT_ID` and `APS_CLIENT_SECRET` from a gitignored `.env` file at the project root — useful when you run locally, because the debugger doesn't inherit the variables you exported in a terminal. In a Codespace your secrets are already in the environment, and the file doesn't exist. VS Code refuses to launch when `envFile` points at a missing file, so **delete that line if you're working in a Codespace.**

> **One server at a time.** Both `npm start` and the debugger bind port `3000`. If you get `EADDRINUSE`, stop whichever one is already running.

## Checkpoint

You should now have:

- [x] `mcp.js` carried over from the beginner project (no changes)
- [x] `index.js` running an Express app at `/mcp`
- [x] `.vscode/mcp.json` pointing Copilot at the HTTP endpoint
- [x] `.vscode/launch.json` with a **Launch MCP Server** debug configuration

### Try it out

1. Start the server: `npm start`, or press <kbd>F5</kbd> to start it under the debugger. You should see `MCP server listening on http://localhost:3000/mcp`.
2. Open VS Code, register the server from `.vscode/mcp.json`, and open Copilot Chat in agent mode.
3. Ask: *"What Forma projects do I have access to?"*
4. Copilot calls `list-hubs-projects` and returns the hubs visible to your APS *application* (the same data you saw in the beginner workshop, since the auth model hasn't changed yet).

The output is still scoped to the app, not a user — exactly what Part 3 will change.

> **Debugging tip — MCP Inspector.** When the HTTP transport doesn't behave, bypass Copilot and connect the MCP Inspector to the running server:
>
> ```bash
> npx @modelcontextprotocol/inspector http://localhost:3000/mcp
> ```
>
> The command starts the Inspector's web UI on port **6274** inside your Codespace. Because the Codespace is a remote environment, the web UI is **not** automatically available in your local browser — you need to forward the port:
>
> 1. Open the **Ports** panel in VS Code (bottom panel → **Ports** tab).
> 2. Look for port `6274` — VS Code usually detects and adds it automatically when the Inspector starts.
> 3. Hover over the **Forwarded Address** column and click the globe icon to open it in your browser.
>
> The Inspector shows the raw JSON-RPC traffic, lets you invoke tools manually, and is the fastest way to isolate transport bugs from tool bugs.
>
> Note that this command connects to your already-running server at `localhost:3000` — **start the server first** with `npm start`, then run the Inspector command in a second terminal.

### Additional resources

- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports#streamable-http)
- [Express middleware reference](https://expressjs.com/en/4x/api.html)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [VS Code Node.js debugging](https://code.visualstudio.com/docs/nodejs/nodejs-debugging)
