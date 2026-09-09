# Part 2: Streamable HTTP

In this section you'll replace the STDIO transport with **Streamable HTTP**, so the MCP server becomes a network service that runs on its own and accepts connections from any MCP client. `mcp.js` and `aps.js` need no changes at all.

## Theory

STDIO worked well locally: VS Code launched `node index.js` as a child process and spoke JSON-RPC over its stdin/stdout. It has three limits, though. One client talks to one process, the server's lifetime is tied to the editor, and nothing listens on a port — which rules out a browser-based OAuth redirect, the whole point of Part 3.

With Streamable HTTP the server runs independently and clients send JSON-RPC messages to a single endpoint. We'll use `/mcp`.

## Step 1: Update index.js

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

> **"Binding to 0.0.0.0 without DNS rebinding protection" warning.** Expected, not an error. Binding to all interfaces is what lets Codespace port forwarding reach the server, and the warning is a reminder that host and origin checks are off outside `localhost`. Harmless on your own machine. The [Extras](extras.md) production checklist covers locking this down.

## Step 2: Update mcp.json

`.vscode/mcp.json` currently points at a STDIO command. Replace the whole file with an HTTP entry:

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

The `envFile` line from Part 1 is gone with it, and doesn't come back. VS Code no longer starts the process, so it has nothing to pass an environment to — the server is already running under its own when a client connects.

The URL must be the same address the server publishes as its own identity — Part 3 puts it in the server's OAuth metadata, and the client has to reach the server where that metadata says it is. Running locally, that's `http://localhost:3000`, which is also what `PUBLIC_URL` falls back to.

> **Using a Codespace?** The server is only reachable through the forwarded address of port `3000`, so use that instead:
>
> ```json
> {
>   "servers": {
>     "APS MCP Server (Advanced)": {
>       "type": "http",
>       "url": "https://${env:CODESPACE_NAME}-3000.${env:GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}/mcp"
>     }
>   }
> }
> ```
>
> Those two variables are set by Codespaces automatically, so the URL resolves without hard-coding your Codespace name.

## Step 3: Setup debugging

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
            "envFile": "${workspaceFolder}/.env"
        }
    ]
}
```

`envFile` points the debugger at the `.env` you created in Part 1, so <kbd>F5</kbd> gets the same `APS_CLIENT_ID` and `APS_CLIENT_SECRET` as `npm start`. The two use different mechanisms for the same file — the `--env-file-if-exists` flag in the `start` script, and this setting in the debugger — because neither launcher knows about the other.

`launch.json` is committed to your repository, so it names the file rather than the values. Never put credentials in it.

> **Using a Codespace?** Change two things. Drop the `envFile` line — there is no `.env` to read, and the debugger fails outright on a missing one; your credentials come from the Codespace secrets, which the debugger inherits anyway. Then add an `env` block, because the server has to publish its forwarded address rather than `localhost`:
>
> ```json
> "program": "${workspaceFolder}/index.js",
> "env": {
>     "PUBLIC_URL": "https://${env:CODESPACE_NAME}-3000.${env:GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
> }
> ```

## Step 4: Run the server

The OAuth flow in Part 3 sends your browser to Autodesk and back again, so the server needs an address your browser can reach. Running locally, that's `http://localhost:3000`.

1. Press <kbd>F5</kbd> (or pick **Launch MCP Server** in the **Run and Debug** panel) to start the server with the debugger attached.

2. Open the **Debug Console** panel (bottom panel → **Debug Console** tab).

   You should see `MCP server listening on http://localhost:3000/mcp`. If instead it exits with `APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.`, the debugger didn't pick up your credentials — check that `.env` exists at the project root and that `envFile` points at it.

3. Register the callback URL with your APS app. Open your APS application on the developer portal and set **Callback URL** to your server's public URL plus `/auth/callback` — `http://localhost:3000/auth/callback`.

   APS accepts several callback URLs, so you can keep others alongside it. This value must match `PUBLIC_URL` exactly — same scheme, same host, no trailing slash difference.

> **Using a Codespace?** Two extra steps, because the browser reaches your server through a forwarded port rather than directly.
>
> - The Debug Console prints the forwarded address instead, something like `MCP server listening on https://fuzzy-octo-robot-abc123-3000.app.github.dev/mcp`. The part before `/mcp` is your server's public address — keep it around.
> - Open the **Ports** panel (bottom panel → **Ports** tab). Port `3000` appears automatically once the server is listening. Right-click it and choose **Port Visibility → Public**. Without this, anything reaching your server from outside the Codespace gets a GitHub login page instead.
> - Use that forwarded address in step 3, so the **Callback URL** reads `https://fuzzy-octo-robot-abc123-3000.app.github.dev/auth/callback`.
>
> The hostname belongs to the Codespace. Delete it and create a new one, and the address changes — repeat this step, including the APS registration.

> **`EADDRINUSE: address already in use :::3000`.** Another server is still running — usually a debug session or a forgotten terminal. Find it and stop it:
>
> ```bash
> lsof -i :3000
> kill <PID>
> ```
>
> Or in one line: `kill $(lsof -t -i:3000)`. On Windows, `netstat -ano | findstr :3000` then `taskkill /PID <PID> /F`.

## Checkpoint

You should now have:

- [x] `index.js` serving an Express app at `/mcp`
- [x] `.vscode/mcp.json` pointing Copilot at the HTTP endpoint
- [x] `.vscode/launch.json` with a **Launch MCP Server** configuration
- [x] The server listening on `http://localhost:3000` (or, in a Codespace, on a forwarded port `3000` set to **Public**)
- [x] A **Callback URL** on your APS app matching `PUBLIC_URL`

## Try it out

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
> It starts a web UI on port `6274` and opens it in your browser. The Inspector shows the raw JSON-RPC traffic and lets you invoke tools by hand — the fastest way to tell a transport problem from a tool problem.
>
> In a Codespace, VS Code adds port `6274` to the **Ports** panel automatically; click the globe icon next to the forwarded address to open it.

## Additional resources

- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports#streamable-http)
- [Forwarding ports in a Codespace](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
- [VS Code Node.js debugging](https://code.visualstudio.com/docs/nodejs/nodejs-debugging)
