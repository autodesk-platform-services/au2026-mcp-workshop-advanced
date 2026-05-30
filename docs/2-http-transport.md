# Part 2: Streamable HTTP

In this section you'll replace the STDIO transport from the beginner session with **Streamable HTTP**. The MCP server becomes a real network service that runs once and accepts connections from any MCP client over the network. Authentication stays 2-legged for now — the user-level OAuth flow comes in Part 3 once the transport groundwork is in place.

## Theory

### STDIO vs. Streamable HTTP

The beginner server used STDIO: VS Code launched `node index.js` as a child process and spoke JSON-RPC over its stdin/stdout. That works beautifully for local development but has three big limitations: only one client can talk to one process, the lifetime is tied to the editor, and there's no way to bolt on a web flow (like an OAuth redirect) because nothing is listening on a port.

`StreamableHTTPServerTransport` from the MCP SDK fixes all three. The server runs independently, clients `POST` JSON-RPC messages to a single endpoint (we'll use `/mcp`), and per-client state is keyed by an `mcp-session-id` header the SDK injects on the first response.

### One MCP server per session

The MCP SDK ties protocol state — pending requests, capabilities, subscriptions — to a transport instance. To keep clients isolated you give each one its own transport, and because tools, resources, and the auth provider are bound at construction time, each one also gets its own `McpServer` instance built by the factory you already wrote in the beginner session.

For now the *auth provider* is shared: one `AppAuthenticationProvider` covers the whole process because every 2-legged token represents the application itself, not any particular user. In Part 3 you'll move it inside the per-session map so each user can hold their own tokens.

## Step 1: Keep the MCP factory unchanged

`mcp.js` from the beginner workshop already returns an `McpServer` built around an injected auth provider. No changes needed in this step — the same factory works under both transports.

If you have not copied it across yet, this is what it should look like:

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getHubsProjects, getFolderContents } from './aps.js';

export function createMcpServer(authenticationProvider) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        version: '1.0.0'
    });

    server.registerTool(
        'list-hubs-projects',
        {
            description: 'Lists all hubs and their projects available to the APS application.',
        },
        async () => {
            const hubs = await getHubsProjects(authenticationProvider);
            const lines = [];
            for (const hub of hubs) {
                lines.push(`- Hub: ${hub.name} (ID: ${hub.id}, region: ${hub.region})`);
                for (const project of hub.projects) {
                    lines.push(`  - Project: ${project.name} (ID: ${project.id})`);
                }
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
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
            const lines = [];
            for (const item of items) {
                if (item.type === 'folders') {
                    lines.push(`- Folder: ${item.name} (ID: ${item.id})`);
                } else if (item.type === 'items') {
                    lines.push(`- File: ${item.name} (ID: ${item.id}, Last modified at ${item.modifiedAt} by ${item.modifiedBy})`);
                }
            }
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
    );

    return server;
}
```

## Step 2: Rewrite the entry point

Replace `index.js` with the HTTP-based version:

```js
import { randomUUID } from 'crypto';
import cors from 'cors';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
const transports = new Map();

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.use(cors());

app.all('/mcp', async (req, res) => {
    const incomingSessionId = req.headers['mcp-session-id'];

    if (incomingSessionId && transports.has(incomingSessionId)) {
        const transport = transports.get(incomingSessionId);
        await transport.handleRequest(req, res, req.body);
        return;
    }

    const sessionId = randomUUID();
    const server = createMcpServer(authenticationProvider);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
    transports.set(sessionId, transport);

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => console.log(`MCP server listening on ${PUBLIC_URL}/mcp`));
```

What's happening:

- `createMcpExpressApp` is an Express app pre-configured by the MCP SDK with the body parsers it expects. Mount your own middleware on it — we add `cors()` so browser-based clients can reach the endpoint.
- The `/mcp` route is shared by all sessions. If the request already carries an `mcp-session-id`, look up the transport from the map and forward the request to it.
- Otherwise allocate a new session ID, build a per-session `McpServer` + `StreamableHTTPServerTransport`, store the transport, and serve the request from the fresh pair.
- Wrap the handler in `try/catch` in production. The snippet keeps things short for readability.

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

When VS Code connects, it issues a `POST` to `/mcp` with no session header. The server allocates a session, returns the ID in the response, and Copilot reuses it for every subsequent message.

## Checkpoint

You should now have:

- [x] `mcp.js` carried over from the beginner project (no changes)
- [x] `index.js` running an Express app at `/mcp`
- [x] `.vscode/mcp.json` pointing Copilot at the HTTP endpoint

### Try it out

1. Start the server: `npm start`. You should see `MCP server listening on http://localhost:3000/mcp`.
2. Open VS Code, register the server from `.vscode/mcp.json`, and open Copilot Chat in agent mode.
3. Ask: *"What Forma projects do I have access to?"*
4. Copilot calls `list-hubs-projects` and returns the hubs visible to your APS *application* (the same data you saw in the beginner workshop, since the auth model hasn't changed yet).

> **Tip:** `npx @modelcontextprotocol/inspector http://localhost:3000/mcp` is the fastest way to debug the HTTP transport without going through Copilot. It shows the JSON-RPC traffic, including the `mcp-session-id` header negotiation.

The output is still scoped to the app, not a user — exactly what Part 3 will change.

### Additional resources

- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
- [Express middleware reference](https://expressjs.com/en/4x/api.html)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
