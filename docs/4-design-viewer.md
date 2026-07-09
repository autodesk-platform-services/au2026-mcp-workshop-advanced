# Part 4: Embedded Viewer

In this section you'll add a new MCP tool called `preview-design` that renders an Autodesk design directly inside the chat using the **APS Viewer**. Unlike the text-only tools from earlier parts, this one returns an **app resource** — a self-contained HTML page that the MCP client loads in a panel. The viewer talks back to the server via `@modelcontextprotocol/ext-apps`, so selecting objects in 3D becomes additional context the AI can reason about.

## Theory

### App tools and app resources

**MCP Apps** is an extension on top of the standard protocol that layers two concepts on top of a normal MCP server:

- **App resource.** A named resource (identified by a `ui://` URI) whose body is an HTML document, served with the MIME type `text/html;profile=mcp-app`. The MCP client renders it in a sandboxed panel with a configurable CSP.
- **App tool.** A tool whose definition references an app resource via `_meta.ui.resourceUri`. When the tool returns, the client shows the resource and forwards the tool's `structuredContent` to it.

The split mirrors the way browsers separate the page from the data: the resource is loaded once and cached; tool results stream in as the AI works.

> **Server-side vs. client-side.** In the JavaScript version of this workshop, the `@modelcontextprotocol/ext-apps` npm package provides `registerAppTool`/`registerAppResource` helpers on the *server*. Those helpers turn out to be thin wrappers that just set `_meta.ui` in the right shape — the MCP Python SDK's `FastMCP` already accepts an arbitrary `meta=` dict on both `@mcp.tool()` and `@mcp.resource()`, so `server.py` builds the same `_meta.ui` structure directly, with no extra dependency. The npm package is still needed, but only in the browser: the viewer page itself imports `@modelcontextprotocol/ext-apps` to talk back to the MCP host.

### What the viewer needs

The APS Viewer is a JavaScript library — it runs inside the MCP client's sandboxed panel, not inside your Python process. It needs:

- The viewer scripts and stylesheet from `developer.api.autodesk.com`.
- An access token to download model derivatives.
- A "URN" — actually a base64 of the design's storage URN — that identifies the model.

We'll bundle the entire viewer HTML (plus our small wrapper script) into a single inlined file with Vite, exactly as the JavaScript session does, so it can be served as a resource with no extra HTTP requests on our side. The only difference is *who reads the bundle*: instead of a JavaScript `import`, `server.py` opens `dist/viewer.html` as a plain text file.

## Step 1: Viewer UI

Create the three files under `ui/`. These are unchanged from the JavaScript session — the viewer runs in the browser regardless of which language the server is written in.

`ui/viewer.html`:

```html
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/style.min.css" type="text/css">
  <script src="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js"></script>
  <link rel="stylesheet" href="./viewer.css">
</head>

<body>
  <div id="viewer"></div>
  <script type="module" src="./viewer.js"></script>
</body>

</html>
```

`ui/viewer.css`:

```css
html,
body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    min-height: 500px;
    overflow: hidden;
}

#viewer {
    width: 100%;
    height: 100%;
}
```

`ui/viewer.js`:

```js
import { App } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Design Viewer', version: '1.0.0' });
app.ontoolresult = ({ structuredContent: { urn, config } = {} }) => {
    if (urn && config) loadModel(urn, config);
};
app.connect();
app.requestDisplayMode({ mode: 'pip' });

let viewerInitializedPromise = null;

function loadModel(urn, config) {
    if (!viewerInitializedPromise) {
        viewerInitializedPromise = new Promise((resolve) => {
            Autodesk.Viewing.Initializer(config, () => {
                const viewer = new Autodesk.Viewing.GuiViewer3D(document.getElementById('viewer'));
                viewer.start();
                viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, () => {
                    const ids = viewer.getSelection();
                    const text = ids.length ? `User selected objects with IDs: ${ids.join(', ')}` : 'No objects selected';
                    app.updateModelContext({ content: [{ type: 'text', text }] });
                });
                resolve(viewer);
            });
        });
    }
    return viewerInitializedPromise.then(viewer => {
        Autodesk.Viewing.Document.load(
            'urn:' + urn,
            (doc) => viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry()),
            (errorCode, errorMessage, errors) => console.error('Failed to load document:', errorCode, errorMessage, errors)
        );
    });
}
```

Two things worth highlighting in `viewer.js`:

- `app.ontoolresult` runs whenever the AI invokes the `preview-design` tool. The `structuredContent` field we return from the server (Step 3) carries the access token, viewer config, and design URN.
- The `SELECTION_CHANGED_EVENT` handler calls `app.updateModelContext(...)`, which feeds the user's current selection back into the AI's context window. The model can then reason about specific elements ("what's the area of the selected slab?") without the user having to type IDs.

## Step 2: Vite build

Create `vite.config.js` at the project root:

```js
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
    root: './ui',
    plugins: [viteSingleFile()],
    build: {
        rollupOptions: {
            input: './ui/viewer.html',
        },
        outDir: '../dist',
        emptyOutDir: false,
    },
});
```

`viteSingleFile()` inlines every script and stylesheet `viewer.html` references (including the compiled `viewer.js`) into one HTML file at `dist/viewer.html`. `server.py` reads that file directly — unlike the JavaScript session, there's no extra plugin step to wrap the HTML in a `.js` module, because Python has no use for a JavaScript `export default`.

Build it now — and remember to re-run this command whenever you change anything under `ui/`:

```bash
npm run build
```

You should see `dist/viewer.html` appear.

> **Required before `python main.py`.** `server.py` reads `dist/viewer.html` at import time. If you skip the build (or pull a fresh clone and run `python main.py` straight away), Python will raise `FileNotFoundError`. Always run `npm run build` at least once before starting the server.

## Step 3: Register the resource and tool

Extend `server.py` to declare the viewer resource and the `preview-design` app tool. Update the imports and constants at the top of the file:

```python
import functools
import json
from pathlib import Path
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent
from pydantic import Field

from aps import get_hubs_projects, get_folder_contents, get_item_tip

VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html'
VIEWER_MIME_TYPE = 'text/html;profile=mcp-app'
VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
]
VIEWER_HTML = (Path(__file__).parent / 'dist' / 'viewer.html').read_text()
```

`VIEWER_MIME_TYPE` is the exact MIME type MCP Apps hosts require for a `ui://` resource. `VIEWER_DOMAINS` ends up in the resource's Content Security Policy so the embedded viewer can call the APS APIs it depends on. `VIEWER_HTML` is read once, at import time — reading a file every time the resource is requested would work too, but there's no reason to re-read a file that Vite already produced as a finished artifact.

Add `public_url` as a third argument to the factory signature (needed for the viewer CSP) and register the `preview-design` tool plus the viewer resource:

```python
def create_mcp_server(authentication_provider, auth_url, public_url):
    # ... existing FastMCP instance, with_auth decorator, and two @mcp.tool registrations ...

    @mcp.tool(
        name='preview-design',
        description='Displays an interactive 3D preview of a design in APS Viewer. Use this when the user wants to visualise, inspect, or explore a design file.',
        meta={'ui': {'resourceUri': VIEWER_RESOURCE_URI}},
        structured_output=False,
    )
    @with_auth
    def preview_design(
        project_id: Annotated[str, Field(description='Project ID the design belongs to.')],
        design_id: Annotated[str, Field(description='Item ID of the design to preview.')],
        region: Annotated[str, Field(description='Hub region (e.g. "US", "EMEA"). Defaults to "US".')] = 'US',
    ) -> CallToolResult:
        access_token = authentication_provider.get_access_token()
        tip = get_item_tip(project_id, design_id, authentication_provider)
        config = {
            'accessToken': access_token,
            'env': 'AutodeskProduction2',
            'api': 'streamingV2' if region == 'US' else f'streamingV2_{region}',
        }
        return CallToolResult(
            structuredContent={'name': tip['name'], 'urn': tip['derivative_urn'], 'config': config},
            content=[TextContent(type='text', text=f'Here is the preview of {tip["name"]}.')],
        )

    @mcp.resource(
        VIEWER_RESOURCE_URI,
        name='viewer',
        mime_type=VIEWER_MIME_TYPE,
        meta={
            'ui': {
                'domain': public_url,
                'csp': {
                    'resourceDomains': [*VIEWER_DOMAINS, 'blob:', 'data:'],
                    'connectDomains': [*VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                },
            },
        },
    )
    def viewer() -> str:
        return VIEWER_HTML

    return mcp
```

What's new versus a normal tool:

- `meta={'ui': {'resourceUri': VIEWER_RESOURCE_URI}}` tells the client which app resource to surface alongside this tool's result — the Python equivalent of `_meta.ui.resourceUri` in the JavaScript session.
- The handler is wrapped in the same `with_auth` decorator used by the other tools, so an unauthenticated session gets the login URL instead of a crash.
- `structured_output=False` stops `FastMCP` from trying to infer an output schema from the `-> CallToolResult` return annotation. Returning a `CallToolResult` directly is an escape hatch FastMCP recognises regardless: it's passed through untouched, which is exactly what's needed here since the handler wants to send **both** `structuredContent` (consumed by `viewer.js` via `ontoolresult`) and a plain text `content` block (shown to the user / model as a confirmation) — a shape a plain return value can't express.
- The access token is fetched first, then the item tip. The token is short-lived and is included in `structuredContent['config']` so the viewer can authenticate its own requests to the derivative service.
- `@mcp.resource(...)` accepts `mime_type` and `meta` directly — no separate resource-registration helper needed. The `meta` dict here is returned verbatim as `_meta` on every `resources/read` response for this URI.

## Step 4: Update the entry point

`main.py` already builds the per-session auth provider and computes its login URL. Add `PUBLIC_URL` as a third argument to the `create_mcp_server` call so the viewer resource knows which origin to whitelist:

```diff
- mcp_server = create_mcp_server(auth_provider, auth_url)
+ mcp_server = create_mcp_server(auth_provider, auth_url, PUBLIC_URL)
```

That's the only change in `main.py`.

## Checkpoint

You should now have:

- [x] `ui/viewer.html`, `ui/viewer.js`, `ui/viewer.css`
- [x] `vite.config.js` and a populated `dist/` directory after `npm run build`
- [x] `server.py` registering the viewer resource and `preview-design` tool
- [x] `main.py` passing `PUBLIC_URL` to `create_mcp_server`

<details>
    <summary>
        Reference: full <code>server.py</code>
    </summary>

```python
import functools
import json
from pathlib import Path
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent
from pydantic import Field

from aps import get_hubs_projects, get_folder_contents, get_item_tip

VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html'
VIEWER_MIME_TYPE = 'text/html;profile=mcp-app'
VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
]
VIEWER_HTML = (Path(__file__).parent / 'dist' / 'viewer.html').read_text()


def create_mcp_server(authentication_provider, auth_url, public_url):
    mcp = FastMCP(name='aps-mcp-server', instructions='MCP server for Autodesk Platform Services')

    def with_auth(handler):
        @functools.wraps(handler)
        def wrapper(*args, **kwargs):
            if not authentication_provider.is_authenticated():
                return f'Authentication is required. Please log in at: {auth_url}'
            return handler(*args, **kwargs)
        return wrapper

    @mcp.tool(
        name='list-hubs-projects',
        description='Lists all hubs and their projects available to the authenticated user.',
        structured_output=False,
    )
    @with_auth
    def list_hubs_projects() -> str:
        hubs = get_hubs_projects(authentication_provider)
        return json.dumps(hubs, indent=2)

    @mcp.tool(
        name='list-folder-contents',
        description='Lists the contents of a folder in a project, or top-level folders if no folder ID is provided.',
        structured_output=False,
    )
    @with_auth
    def list_folder_contents(
        hub_id: Annotated[str, Field(description='Hub ID.')],
        project_id: Annotated[str, Field(description='Project ID.')],
        folder_id: Annotated[str | None, Field(description='Folder ID. Omit to list top-level folders.')] = None,
    ) -> str:
        items = get_folder_contents(hub_id, project_id, folder_id, authentication_provider)
        return json.dumps(items, indent=2)

    @mcp.tool(
        name='preview-design',
        description='Displays an interactive 3D preview of a design in APS Viewer. Use this when the user wants to visualise, inspect, or explore a design file.',
        meta={'ui': {'resourceUri': VIEWER_RESOURCE_URI}},
        structured_output=False,
    )
    @with_auth
    def preview_design(
        project_id: Annotated[str, Field(description='Project ID the design belongs to.')],
        design_id: Annotated[str, Field(description='Item ID of the design to preview.')],
        region: Annotated[str, Field(description='Hub region (e.g. "US", "EMEA"). Defaults to "US".')] = 'US',
    ) -> CallToolResult:
        access_token = authentication_provider.get_access_token()
        tip = get_item_tip(project_id, design_id, authentication_provider)
        config = {
            'accessToken': access_token,
            'env': 'AutodeskProduction2',
            'api': 'streamingV2' if region == 'US' else f'streamingV2_{region}',
        }
        return CallToolResult(
            structuredContent={'name': tip['name'], 'urn': tip['derivative_urn'], 'config': config},
            content=[TextContent(type='text', text=f'Here is the preview of {tip["name"]}.')],
        )

    @mcp.resource(
        VIEWER_RESOURCE_URI,
        name='viewer',
        mime_type=VIEWER_MIME_TYPE,
        meta={
            'ui': {
                'domain': public_url,
                'csp': {
                    'resourceDomains': [*VIEWER_DOMAINS, 'blob:', 'data:'],
                    'connectDomains': [*VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                },
            },
        },
    )
    def viewer() -> str:
        return VIEWER_HTML

    return mcp
```

</details>

<details>
    <summary>
        Reference: full <code>main.py</code>
    </summary>

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
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route

from mcp.server.streamable_http import MCP_SESSION_ID_HEADER, StreamableHTTPServerTransport

from aps import UserAuthenticationProvider
from server import create_mcp_server

APS_CLIENT_ID = os.environ.get('APS_CLIENT_ID')
APS_CLIENT_SECRET = os.environ.get('APS_CLIENT_SECRET')
if not APS_CLIENT_ID or not APS_CLIENT_SECRET:
    print('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.', file=sys.stderr)
    sys.exit(1)
PORT = int(os.environ.get('PORT', '3000'))
PUBLIC_URL = os.environ.get('PUBLIC_URL', f'http://localhost:{PORT}')
CALLBACK_URL = f'{PUBLIC_URL}/auth/callback'


@dataclass
class Session:
    transport: StreamableHTTPServerTransport
    auth_provider: UserAuthenticationProvider


sessions: dict[str, Session] = {}
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
            sessions.pop(session_id, None)


async def mcp_app(scope, receive, send):
    request = Request(scope, receive)
    session_id = request.headers.get(MCP_SESSION_ID_HEADER)

    if session_id and session_id in sessions:
        await sessions[session_id].transport.handle_request(scope, receive, send)
    elif not session_id:
        new_session_id = uuid.uuid4().hex
        transport = StreamableHTTPServerTransport(mcp_session_id=new_session_id)
        auth_provider = UserAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET, CALLBACK_URL)
        sessions[new_session_id] = Session(transport, auth_provider)
        auth_url = auth_provider.get_authorization_url(new_session_id)
        mcp_server = create_mcp_server(auth_provider, auth_url, PUBLIC_URL)
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


async def auth_callback(request):
    code = request.query_params.get('code')
    session_id = request.query_params.get('state')
    if not code or not session_id:
        return PlainTextResponse('Missing code or state parameter.', status_code=400)
    session = sessions.get(session_id)
    if not session:
        return PlainTextResponse('Invalid or expired session ID.', status_code=400)
    try:
        session.auth_provider.exchange_auth_code(code)
        return PlainTextResponse('Login successful! You can close this window and return to your AI assistant.')
    except Exception as err:
        print('Auth callback error:', err, file=sys.stderr)
        return PlainTextResponse('Authentication failed.', status_code=500)


@contextlib.asynccontextmanager
async def lifespan(app):
    global task_group
    async with anyio.create_task_group() as tg:
        task_group = tg
        yield
        tg.cancel_scope.cancel()


app = Starlette(
    routes=[
        Mount('/mcp', app=mcp_app),
        Route('/auth/callback', auth_callback, methods=['GET']),
    ],
    middleware=[
        Middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], expose_headers=['Mcp-Session-Id']),
    ],
    lifespan=lifespan,
)

uvicorn.run(app, host='0.0.0.0', port=PORT)
```

</details>

<details>
    <summary>
        Reference: full <code>vite.config.js</code>
    </summary>

```js
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
    root: './ui',
    plugins: [viteSingleFile()],
    build: {
        rollupOptions: {
            input: './ui/viewer.html',
        },
        outDir: '../dist',
        emptyOutDir: false,
    },
});
```

</details>

### Try it out

1. Rebuild and restart: `npm run build && python main.py`.
2. In Copilot Chat (agent mode, with the HTTP server registered), ask for a design preview, for example:

   > Open one of my Forma designs in the viewer.

3. Copilot may chain calls: `list-hubs-projects` → `list-folder-contents` → `preview-design`. Approve any tool prompts.
4. After `preview-design` runs, the viewer panel appears with the model loaded. Select an object — the chat now knows what's selected and can answer follow-up questions about it.

> **Cache busting.** If you rebuild the viewer while a Copilot session is open, restart the MCP server so it re-reads the new `dist/viewer.html` and the next session loads the fresh resource.

### Where next?

You've now got an HTTP MCP server with per-user OAuth and an embedded 3D viewer — the same building blocks production APS integrations use. The [Extras](extras.md) page covers spec-driven development with GitHub Spec-Kit (recommended once changes start touching multiple layers at once) and a production checklist for shipping this server as a real service.

### Additional resources

- [APS Viewer developer guide](https://aps.autodesk.com/en/docs/viewer/v7/developers_guide/overview/)
- [`@modelcontextprotocol/ext-apps` documentation](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
- [MCP UI resources spec](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)
