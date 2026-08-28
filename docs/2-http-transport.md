# Part 2: Streamable HTTP

In this section you'll replace the STDIO transport with **Streamable HTTP**, so the MCP server becomes a network service that runs on its own and accepts connections from any MCP client. `mcp.js` and `aps.js` need no changes at all.

## Theory

STDIO worked well locally: VS Code launched `node index.js` as a child process and spoke JSON-RPC over its stdin/stdout. It has three limits, though. One client talks to one process, the server's lifetime is tied to the editor, and nothing listens on a port — which rules out a browser-based OAuth redirect, the whole point of Part 3.

With Streamable HTTP the server runs independently and clients send JSON-RPC messages to a single endpoint. We'll use `/mcp`.

## Step 1: Rewrite the entry point

Replace `index.js` with the HTTP version:

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

What this does:

- `createMcpExpressApp` returns an Express app pre-configured for MCP servers, with a JSON body parser already installed. Add your own middleware to it, as we do with `cors()`.
- `createMcpHandler` takes a factory function (creating MCP servers) and turns it into an HTTP handler that speakss the 2026-07-28 protocol. `toNodeHandler` adapts that handler to the `(req, res)` shape Express expects.
- Passing `req.body` as the third argument matters: the Express app already parsed the request stream, so the handler must be handed the result rather than trying to parse the input stream again.
- Errors thrown inside a tool handler come back as proper JSON-RPC errors, so there's no `try`/`catch` here.
- `PUBLIC_URL` is only used in the log line for now. Part 3 needs it for the OAuth callback and Part 4 for the viewer's security policy.

> **"Binding to 0.0.0.0 without DNS rebinding protection" warning.** Expected, not an error. Codespace port forwarding needs the server listening on all interfaces, and the warning is a reminder that host and origin checks are off outside `localhost`. The [Extras](extras.md) production checklist covers locking this down.

## Step 2: Point VS Code at the HTTP endpoint

`.vscode/mcp.json` currently points at a STDIO command. Replace it with an HTTP entry:

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

`localhost:3000` is correct even in a Codespace: Copilot runs inside the same environment as the server.

> [!CAUTION]
> **TODO** verify this claim ^

## Step 3: Add a debug launch configuration

`npm start` runs the server but gives you no debugging capabilities. Create `.vscode/launch.json`:

```json
{
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
            "env": {
                "PUBLIC_URL": "https://${env:CODESPACE_NAME}-3000.${env:GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
            }
        }
    ]
}
```

The `env` block builds the public URL from the two variables Codespaces sets automatically, so the debugger gets the same value your terminal will get in Step 4.

> [!CAUTION]
> **TODO** verify this claim ^

`APS_CLIENT_ID` and `APS_CLIENT_SECRET` are already in the Codespace environment, so the debugger inherits them.

> **Working locally?** Delete the `env` block — those two variables don't exist outside a Codespace, and `PUBLIC_URL` then falls back to `http://localhost:3000`.

## Step 4: Run the server in your Codespace

The OAuth flow in Part 3 sends your browser to Autodesk and back again, so the server needs a URL reachable from outside the Codespace. Codespaces gives you one by forwarding port `3000`.

1. Press <kbd>F5</kbd> (or pick **Launch MCP Server** in the **Run and Debug** panel) to start the server with the debugger attached.

2. Open the **Debug Console** panel (bottom panel → **Debug Console** tab).

  You should see something like `MCP server listening on https://fuzzy-octo-robot-abc123-3000.app.github.dev/mcp`. The part before `/mcp` is your server's public address. Keep it around as we'll need it later.

3. Open the **Ports** panel (bottom panel → **Ports** tab). Port `3000` appears automatically once the server is listening. Right-click it and choose **Port Visibility → Public**.

   Without this, anyone accessing your MCP server from outside of the Codespace would get a GitHub login page.

4. Register the callback URL with your APS app. Open your APS application on the developer portal and set **Callback URL** to your server's public URL plus `/auth/callback`, for example, `https://fuzzy-octo-robot-abc123-3000.app.github.dev/auth/callback`.

   APS accepts several callback URLs, so you can keep others alongside it. This value must match `PUBLIC_URL` exactly — same scheme, same host, no trailing slash difference.

> **Codespace URLs are per-Codespace.** Delete the Codespace and create a new one, and the hostname changes. When that happens, repeat steps 1, 3 and 4.

> **`EADDRINUSE: address already in use :::3000`.** Another server is still running — usually a debug session or a forgotten terminal. Find it and stop it:
>
> ```bash
> lsof -i :3000
> kill <PID>
> ```
>
> Or in one line: `kill $(lsof -t -i:3000)`.

## Checkpoint

You should now have:

- [x] `index.js` serving an Express app at `/mcp`
- [x] `.vscode/mcp.json` pointing Copilot at the HTTP endpoint
- [x] `.vscode/launch.json` with a **Launch MCP Server** configuration
- [x] Port `3000` forwarded and public
- [x] A **Callback URL** on your APS app matching `PUBLIC_URL`

### Try it out

1. With the server running, open `.vscode/mcp.json` and click **Start** above the server entry to register it.
2. Open Copilot Chat in agent mode and ask: *"What Forma projects do I have access to?"*
3. Copilot calls `list-hubs-projects` and returns the hubs visible to your APS **application**.

The results are still scoped to the application, not to you — that's what Part 3 changes.

> **Debugging tip — MCP Inspector.** When the transport misbehaves, bypass Copilot. With the server already running, open a second terminal and connect the Inspector to it:
>
> ```bash
> npx @modelcontextprotocol/inspector http://localhost:3000/mcp
> ```
>
> It starts a web UI on port `6274`, which VS Code adds to the **Ports** panel automatically. Click the globe icon next to the forwarded address to open it. The Inspector shows the raw JSON-RPC traffic and lets you invoke tools by hand — the fastest way to tell a transport problem from a tool problem.

### Additional resources

- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports#streamable-http)
- [Forwarding ports in a Codespace](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [VS Code Node.js debugging](https://code.visualstudio.com/docs/nodejs/nodejs-debugging)
