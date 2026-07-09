# Part 2: Streamable HTTP

In this section you'll replace the STDIO transport from the beginner session with **Streamable HTTP**. The MCP server becomes a real network service that runs once and accepts connections from any MCP client over the network. Authentication stays 2-legged for now — the user-level OAuth flow comes in Part 3 once the transport groundwork is in place.

## Theory

### STDIO vs. Streamable HTTP

The beginner server used STDIO: VS Code launched `python main.py` as a child process and spoke JSON-RPC over its stdin/stdout. That works beautifully for local development but has three big limitations: only one client can talk to one process, the lifetime is tied to the editor, and there's no way to bolt on a web flow (like an OAuth redirect) because nothing is listening on a port.

The MCP Python SDK's `StreamableHTTPServerTransport` fixes all three. The server runs independently, clients `POST` JSON-RPC messages to a single endpoint (we'll use `/mcp/`), and per-client state is keyed by an `Mcp-Session-Id` header the SDK injects on the first response.

### One MCP server per session

The MCP SDK ties protocol state — pending requests, capabilities, subscriptions — to a transport instance. To keep clients isolated you give each one its own transport, and because tools, resources, and the auth provider are bound at construction time, each one also gets its own `FastMCP` instance built by the factory you already wrote in the beginner session.

For now the *auth provider* is shared: one `AppAuthenticationProvider` covers the whole process because every 2-legged token represents the application itself, not any particular user. In Part 3 you'll move it inside the per-session map so each user can hold their own tokens.

### Why Starlette, not Flask or FastAPI

`StreamableHTTPServerTransport` speaks raw ASGI (`scope`, `receive`, `send`) so it can stream Server-Sent Events back to the client — a normal WSGI framework like Flask can't do that. Starlette is the lightweight ASGI toolkit the MCP Python SDK itself is built on, so it's the natural fit for wiring a custom multi-session route by hand. `uvicorn` is the ASGI server that actually accepts TCP connections and runs the Starlette app.

## Step 1: Keep the MCP factory unchanged

`server.py` from the beginner workshop already returns a `FastMCP` instance built around an injected auth provider. No changes needed in this step — the same factory works under both transports.

If you have not copied it across yet, this is what it should look like:

```python
import json
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from aps import get_hubs_projects, get_folder_contents


def create_mcp_server(authentication_provider):
    mcp = FastMCP(name='aps-mcp-server', instructions='MCP server for Autodesk Platform Services')

    @mcp.tool(
        name='list-hubs-projects',
        description='Lists all hubs and their projects available to the APS application.',
        structured_output=False,
    )
    def list_hubs_projects() -> str:
        hubs = get_hubs_projects(authentication_provider)
        return json.dumps(hubs, indent=2)

    @mcp.tool(
        name='list-folder-contents',
        description='Lists the contents of a folder in a project, or top-level folders if no folder ID is provided.',
        structured_output=False,
    )
    def list_folder_contents(
        hub_id: Annotated[str, Field(description='Hub ID.')],
        project_id: Annotated[str, Field(description='Project ID.')],
        folder_id: Annotated[str | None, Field(description='Folder ID. Omit to list top-level folders.')] = None,
    ) -> str:
        items = get_folder_contents(hub_id, project_id, folder_id, authentication_provider)
        return json.dumps(items, indent=2)

    return mcp
```

## Step 2: Rewrite the entry point

Replace `main.py` with the HTTP-based version:

```python
import contextlib
import os
import sys
import uuid
from dataclasses import dataclass

import anyio
import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount

from mcp.server.streamable_http import MCP_SESSION_ID_HEADER, StreamableHTTPServerTransport

from aps import AppAuthenticationProvider
from server import create_mcp_server

APS_CLIENT_ID = os.environ.get('APS_CLIENT_ID')
APS_CLIENT_SECRET = os.environ.get('APS_CLIENT_SECRET')
if not APS_CLIENT_ID or not APS_CLIENT_SECRET:
    print('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.', file=sys.stderr)
    sys.exit(1)
PORT = int(os.environ.get('PORT', '3000'))
PUBLIC_URL = os.environ.get('PUBLIC_URL', f'http://localhost:{PORT}')

authentication_provider = AppAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET)
transports: dict[str, StreamableHTTPServerTransport] = {}
task_group: anyio.abc.TaskGroup | None = None


async def run_session(transport, mcp_server, session_id, *, task_status):
    async with transport.connect() as (read_stream, write_stream):
        task_status.started()
        try:
            await mcp_server._mcp_server.run(
                read_stream, write_stream, mcp_server._mcp_server.create_initialization_options()
            )
        except Exception as err:
            print(f'Session {session_id} crashed:', err, file=sys.stderr)
        finally:
            transports.pop(session_id, None)


async def mcp_app(scope, receive, send):
    request = Request(scope, receive)
    session_id = request.headers.get(MCP_SESSION_ID_HEADER)

    if session_id and session_id in transports:
        await transports[session_id].handle_request(scope, receive, send)
    elif not session_id:
        new_session_id = uuid.uuid4().hex
        transport = StreamableHTTPServerTransport(mcp_session_id=new_session_id)
        transports[new_session_id] = transport
        mcp_server = create_mcp_server(authentication_provider)
        assert task_group is not None
        await task_group.start(run_session, transport, mcp_server, new_session_id)
        await transport.handle_request(scope, receive, send)
    else:
        response = JSONResponse(
            {
                'jsonrpc': '2.0',
                'error': {'code': -32000, 'message': 'Bad Request: No valid session ID provided'},
                'id': None,
            },
            status_code=400,
        )
        await response(scope, receive, send)


@contextlib.asynccontextmanager
async def lifespan(app):
    global task_group
    async with anyio.create_task_group() as tg:
        task_group = tg
        yield
        tg.cancel_scope.cancel()


app = Starlette(
    routes=[Mount('/mcp', app=mcp_app)],
    middleware=[
        Middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], expose_headers=['Mcp-Session-Id']),
    ],
    lifespan=lifespan,
)

uvicorn.run(app, host='0.0.0.0', port=PORT)
```

What's happening:

- `StreamableHTTPServerTransport` is the low-level, per-connection class the MCP Python SDK exposes for exactly this situation — one transport per session, wired to a `FastMCP` instance you build yourself, instead of the SDK's built-in multi-session helper (which assumes one shared server for every client).
- `mcp_app` is mounted at `/mcp` as a raw ASGI callable (via `Mount`, not `Route`) because `transport.handle_request(scope, receive, send)` needs to stream a Server-Sent Events response itself — a normal request-in, response-out handler can't do that.
- A request carrying a known `Mcp-Session-Id` header is served from its stored transport. A request with no session header always gets a fresh transport and a brand-new per-session `FastMCP` instance; if the very first message on that transport isn't actually `initialize`, the MCP protocol layer itself rejects it. Anything else (a stale or unknown session ID) gets a `400` JSON-RPC error.
- `transport.connect()` is an async context manager that yields the read/write streams the underlying `FastMCP` server needs. Because that has to keep running for the *whole life of the session* — not just one HTTP request — `run_session` runs as a background task in a shared `anyio` task group, started from the Starlette app's `lifespan`. `task_group.start(...)` waits until `task_status.started()` fires, so by the time `mcp_app` calls `transport.handle_request(...)`, the session is already listening.
- The `finally` block removes the transport from the `transports` map once its background task ends (the session closed), so the map only ever holds live sessions.

> **Trailing slash.** Starlette's `Mount` only matches `/mcp/...` — a bare `POST /mcp` gets a `307` redirect to `/mcp/`. Most MCP clients (including VS Code) follow redirects transparently, but to avoid the extra round trip this workshop's `.vscode/mcp.json` and `curl` examples use the trailing-slash URL directly.

> **Public URL.** `PUBLIC_URL` is unused right now but worth threading through — Part 3 needs it for the OAuth callback and Part 4 needs it for the viewer's CSP.

## Step 3: Update the VS Code integration

`.vscode/mcp.json` from the beginner session pointed at a STDIO command. Replace it with an HTTP entry:

```json
{
  "servers": {
    "APS MCP Server (Advanced)": {
      "type": "http",
      "url": "http://localhost:3000/mcp/"
    }
  }
}
```

When VS Code connects, it issues a `POST` to `/mcp/` with no session header. The server allocates a session, returns the ID in the response, and Copilot reuses it for every subsequent message.

## Checkpoint

You should now have:

- [x] `server.py` carried over from the beginner project (no changes)
- [x] `main.py` running a Starlette + uvicorn app at `/mcp/`
- [x] `.vscode/mcp.json` pointing Copilot at the HTTP endpoint

### Try it out

1. Start the server: `python main.py`. You should see `Uvicorn running on http://0.0.0.0:3000`.
2. Open VS Code, register the server from `.vscode/mcp.json`, and open Copilot Chat in agent mode.
3. Ask: *"What Forma projects do I have access to?"*
4. Copilot calls `list-hubs-projects` and returns the hubs visible to your APS *application* (the same data you saw in the beginner workshop, since the auth model hasn't changed yet).

The output is still scoped to the app, not a user — exactly what Part 3 will change.

> **Debugging tip — MCP Inspector.** When the HTTP transport doesn't behave, bypass Copilot and connect the MCP Inspector to the running server:
>
> ```bash
> npx @modelcontextprotocol/inspector http://localhost:3000/mcp/
> ```
>
> The command starts the Inspector's web UI on port **6274** inside your Codespace. Because the Codespace is a remote environment, the web UI is **not** automatically available in your local browser — you need to forward the port:
>
> 1. Open the **Ports** panel in VS Code (bottom panel → **Ports** tab).
> 2. Look for port `6274` — VS Code usually detects and adds it automatically when the Inspector starts.
> 3. Hover over the **Forwarded Address** column and click the globe icon to open it in your browser.
>
> The Inspector shows the JSON-RPC traffic (including the `Mcp-Session-Id` header negotiation), lets you invoke tools manually, and is the fastest way to isolate transport bugs from tool bugs.
>
> Note that this command connects to your already-running server at `localhost:3000` — **start the server first** with `python main.py`, then run the Inspector command in a second terminal.

### Additional resources

- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
- [Starlette documentation](https://www.starlette.io/)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
