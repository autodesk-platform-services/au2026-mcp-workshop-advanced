# Part 4: Embedded Viewer

In this section you'll add a new MCP tool called `preview-design` that renders an Autodesk design directly inside the chat using the **APS Viewer**. Unlike the text-only tools from earlier parts, this one returns an **app resource** — a self-contained HTML page that the MCP client loads in a panel. The viewer talks back to the server via `@modelcontextprotocol/ext-apps`'s browser-side client, so selecting objects in 3D becomes additional context the AI can reason about.

## Theory

### App tools and app resources

MCP Apps layers two concepts on top of the standard MCP server, both expressed as plain `_meta` fields on the standard `registerTool` / `registerResource` calls you already know from the beginner session:

- **App resource.** A named resource (identified by a `ui://` URI) whose body is an HTML document, registered with the `text/html;profile=mcp-app` MIME type. The MCP client renders it in a sandboxed panel with a configurable CSP.
- **App tool.** A tool whose `_meta.ui.resourceUri` field references an app resource. When the tool returns, the client shows the resource and forwards the tool's `structuredContent` to it.

The split mirrors the way browsers separate the page from the data: the resource is loaded once and cached; tool results stream in as the AI works.

> **Design note:** `@modelcontextprotocol/ext-apps` used to ship a `registerAppTool` / `registerAppResource` pair of server-side helpers that did nothing more than set these `_meta` fields for you. As of this writing that package hasn't been updated for MCP SDK v2 yet, so this workshop registers the resource and tool directly with `server.registerTool` / `server.registerResource` and sets `_meta` by hand — one less dependency, and it reads as plain MCP once you know the two fields to set. `@modelcontextprotocol/ext-apps` is still a real dependency of this project, just narrowed to the one thing that isn't optional: the browser-side `App` client `viewer.js` uses to talk back to the host.

### What the viewer needs

The APS Viewer is a JavaScript library. It needs:

- The viewer scripts and stylesheet from `developer.api.autodesk.com`.
- An access token to download model derivatives.
- A "URN" — actually a base64 of the design's storage URN — that identifies the model.

We'll bundle the entire viewer HTML (plus our small wrapper script) into a single inlined file so it can be served as a resource with no extra HTTP requests on our side.

## Step 1: Viewer UI

Create the three files under `ui/`:

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

- `app.ontoolresult` runs whenever the AI invokes the `preview-design` tool. The `structuredContent` field we return from the server carries the access token, viewer config, and design URN.
- The `SELECTION_CHANGED_EVENT` handler calls `app.updateModelContext(...)`, which feeds the user's current selection back into the AI's context window. The model can then reason about specific elements ("what's the area of the selected slab?") without the user having to type IDs.

## Step 2: Vite build

Create `vite.config.js` at the project root:

```js
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
    root: './ui',
    plugins: [
        viteSingleFile(),
        {
            name: 'emit-viewer-module',
            closeBundle() {
                const html = readFileSync(join('dist', 'viewer.html'), 'utf-8');
                writeFileSync(join('dist', 'viewer.js'), `export default ${JSON.stringify(html)};\n`);
            },
        },
    ],
    build: {
        rollupOptions: {
            input: './ui/viewer.html',
        },
        outDir: '../dist',
        emptyOutDir: false,
    },
});
```

What this does:

1. `viteSingleFile()` inlines every script and stylesheet `viewer.html` references into one HTML file.
2. The custom `emit-viewer-module` plugin reads that final HTML, JSON-stringifies it, and writes it to `dist/viewer.js` as `export default "...";`.
3. The MCP server then imports `dist/viewer.js` and serves the string as the resource body — no need to add static-file routes to Express.

Build it now — and remember to re-run this command whenever you change anything under `ui/`:

```bash
npm run build
```

You should see `dist/viewer.html` and `dist/viewer.js` appear.

> **Required before `npm start`.** The server's `mcp.js` imports `./dist/viewer.js` at startup. If you skip the build (or pull a fresh clone and run `npm start` straight away), Node will throw `Cannot find module './dist/viewer.js'`. Always run `npm run build` at least once before starting the server.

## Step 3: Register the resource and tool

Extend `mcp.js` to declare the viewer resource and the `preview-design` tool. Update the imports and constants at the top of the file:

```js
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHubsProjects, getFolderContents, getItemTip } from './aps.js';
import VIEWER_HTML from './dist/viewer.js';

const VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html';
const VIEWER_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
];
```

`VIEWER_RESOURCE_MIME_TYPE` is the MIME type MCP Apps uses to mark a resource as an app UI. The `VIEWER_DOMAINS` list ends up in the resource's Content Security Policy so the embedded viewer can call the APS APIs it depends on.

Add `publicUrl` as a second argument to the factory signature (needed for the viewer CSP) and register the `preview-design` tool plus the viewer resource **before** `return server`:

```js
export function createMcpServer(authenticationProvider, publicUrl) {
    // ... existing McpServer, withAuth helper, and two registerTool calls ...

    server.registerTool(
        'preview-design',
        {
            description: 'Displays an interactive 3D preview of a design in APS Viewer. Use this when the user wants to visualise, inspect, or explore a design file.',
            inputSchema: z.object({
                projectId: z.string().describe('Project ID the design belongs to.'),
                designId: z.string().describe('Item ID of the design to preview.'),
                region: z.string().optional().describe('Hub region (e.g. "US", "EMEA"). Defaults to "US".'),
            }),
            _meta: {
                ui: { resourceUri: VIEWER_RESOURCE_URI },
            },
        },
        withAuth(async ({ projectId, designId, region = 'US' }) => {
            const accessToken = await authenticationProvider.getAccessToken();
            const tip = await getItemTip(projectId, designId, authenticationProvider);
            const config = {
                accessToken,
                env: 'AutodeskProduction2',
                api: region === 'US' ? 'streamingV2' : `streamingV2_${region}`,
            };
            return {
                structuredContent: { name: tip.name, urn: tip.derivativeUrn, config },
                content: [{ type: 'text', text: `Here is the preview of ${tip.name}.` }],
            };
        })
    );

    server.registerResource(
        'viewer',
        VIEWER_RESOURCE_URI,
        { mimeType: VIEWER_RESOURCE_MIME_TYPE },
        async (uri) => ({
            contents: [{
                uri: uri.toString(),
                mimeType: VIEWER_RESOURCE_MIME_TYPE,
                text: VIEWER_HTML,
                _meta: {
                    ui: {
                        domain: publicUrl,
                        csp: {
                            resourceDomains: [...VIEWER_DOMAINS, 'blob:', 'data:'],
                            connectDomains: [...VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                        },
                    },
                },
            }]
        })
    );

    return server;
}
```

What's new versus a normal tool:

- `_meta.ui.resourceUri` tells the client which app resource to surface alongside this tool's result — that's the entire contract between a tool and its UI.
- The handler is wrapped in the same `withAuth` helper used by the other tools, so an unauthenticated session gets the login URL instead of a crash.
- The handler returns **both** `structuredContent` (consumed by `viewer.js` via `ontoolresult`) and a plain text `content` block (shown to the user / model as a confirmation).
- The access token is fetched first, then the item tip. The token is short-lived and is included in `structuredContent.config` so the viewer can authenticate its own requests to the derivative service.
- The resource's read callback receives the request `uri` as a `URL` — echo it back on `contents[0].uri` (MCP requires each content entry to carry its own URI) and set `mimeType` again on the content entry alongside the resource-level one.

## Step 4: Update the entry point

`index.js` already builds the shared auth provider and hands the factory to `createMcpHandler`. Add `PUBLIC_URL` as a second argument to the `createMcpServer` call so the viewer resource knows which origin to whitelist:

```diff
- const mcpHandler = createMcpHandler(() => createMcpServer(authProvider));
+ const mcpHandler = createMcpHandler(() => createMcpServer(authProvider, PUBLIC_URL));
```

That's the only change in `index.js`.

## Checkpoint

You should now have:

- [x] `ui/viewer.html`, `ui/viewer.js`, `ui/viewer.css`
- [x] `vite.config.js` and a populated `dist/` directory after `npm run build`
- [x] `mcp.js` registering the viewer resource and `preview-design` tool
- [x] `index.js` passing `PUBLIC_URL` to `createMcpServer`

<details>
    <summary>
        Reference: full <code>mcp.js</code>
    </summary>

```js
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHubsProjects, getFolderContents, getItemTip } from './aps.js';
import VIEWER_HTML from './dist/viewer.js';

const VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html';
const VIEWER_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
];

export function createMcpServer(authenticationProvider, publicUrl) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        description: 'MCP server for Autodesk Platform Services',
        version: '1.0.0'
    });

    const authUrl = authenticationProvider.getAuthorizationUrl();

    const withAuth = (handler) => async (input) => {
        if (!authenticationProvider.isAuthenticated()) {
            return { content: [{ type: 'text', text: `Authentication is required. Please log in at: ${authUrl}` }] };
        }
        return await handler(input);
    };

    server.registerTool(
        'list-hubs-projects',
        {
            description: 'Lists all hubs and their projects available to the authenticated user.'
        },
        withAuth(async () => {
            const hubs = await getHubsProjects(authenticationProvider);
            return { content: [{ type: 'text', text: JSON.stringify(hubs, null, 2) }] };
        })
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
        withAuth(async ({ hubId, projectId, folderId }) => {
            const items = await getFolderContents(hubId, projectId, folderId, authenticationProvider);
            return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        'preview-design',
        {
            description: 'Displays an interactive 3D preview of a design in APS Viewer. Use this when the user wants to visualise, inspect, or explore a design file.',
            inputSchema: z.object({
                projectId: z.string().describe('Project ID the design belongs to.'),
                designId: z.string().describe('Item ID of the design to preview.'),
                region: z.string().optional().describe('Hub region (e.g. "US", "EMEA"). Defaults to "US".'),
            }),
            _meta: {
                ui: { resourceUri: VIEWER_RESOURCE_URI },
            },
        },
        withAuth(async ({ projectId, designId, region = 'US' }) => {
            const accessToken = await authenticationProvider.getAccessToken();
            const tip = await getItemTip(projectId, designId, authenticationProvider);
            const config = {
                accessToken,
                env: 'AutodeskProduction2',
                api: region === 'US' ? 'streamingV2' : `streamingV2_${region}`,
            };
            return {
                structuredContent: { name: tip.name, urn: tip.derivativeUrn, config },
                content: [{ type: 'text', text: `Here is the preview of ${tip.name}.` }],
            };
        })
    );

    server.registerResource(
        'viewer',
        VIEWER_RESOURCE_URI,
        { mimeType: VIEWER_RESOURCE_MIME_TYPE },
        async (uri) => ({
            contents: [{
                uri: uri.toString(),
                mimeType: VIEWER_RESOURCE_MIME_TYPE,
                text: VIEWER_HTML,
                _meta: {
                    ui: {
                        domain: publicUrl,
                        csp: {
                            resourceDomains: [...VIEWER_DOMAINS, 'blob:', 'data:'],
                            connectDomains: [...VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                        },
                    },
                },
            }]
        })
    );

    return server;
}
```

</details>

<details>
    <summary>
        Reference: full <code>index.js</code>
    </summary>

```js
import cors from 'cors';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { UserAuthenticationProvider } from './aps.js';
import { createMcpServer } from './mcp.js';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    console.error('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.');
    process.exit(1);
}
const PORT = parseInt(process.env.PORT || '3000');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const CALLBACK_URL = `${PUBLIC_URL}/auth/callback`;

const authProvider = new UserAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET, CALLBACK_URL);
const mcpHandler = createMcpHandler(() => createMcpServer(authProvider, PUBLIC_URL));

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.use(cors());

const mcpNodeHandler = toNodeHandler(mcpHandler);
app.all('/mcp', (req, res) => mcpNodeHandler(req, res, req.body));

app.get('/auth/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code parameter.');
    try {
        await authProvider.exchangeAuthCode(code);
        res.send('Login successful! You can close this window and return to your AI assistant.');
    } catch (err) {
        console.error('Auth callback error:', err);
        res.status(500).send('Authentication failed.');
    }
});

app.listen(PORT, () => console.log(`MCP server listening on ${PUBLIC_URL}/mcp`));
```

</details>

<details>
    <summary>
        Reference: full <code>vite.config.js</code>
    </summary>

```js
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
    root: './ui',
    plugins: [
        viteSingleFile(),
        {
            name: 'emit-viewer-module',
            closeBundle() {
                const html = readFileSync(join('dist', 'viewer.html'), 'utf-8');
                writeFileSync(join('dist', 'viewer.js'), `export default ${JSON.stringify(html)};\n`);
            },
        },
    ],
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

1. Rebuild and restart: `npm run build && npm start`.
2. In Copilot Chat (agent mode, with the HTTP server registered), ask for a design preview, for example:

   > Open one of my Forma designs in the viewer.

3. Copilot may chain calls: `list-hubs-projects` → `list-folder-contents` → `preview-design`. Approve any tool prompts.
4. After `preview-design` runs, the viewer panel appears with the model loaded. Select an object — the chat now knows what's selected and can answer follow-up questions about it.

> **Cache busting.** If you rebuild the viewer while a Copilot session is open, restart the MCP server so the new `dist/viewer.js` is imported and the next session loads the fresh resource.

### Where next?

You've now got an HTTP MCP server that authenticates as a real Autodesk user via 3-legged OAuth, with an embedded 3D viewer on top — the core mechanics behind any AI assistant that acts on Autodesk Platform Services on a user's behalf. The [Extras](extras.md) page covers spec-driven development with GitHub Spec-Kit (recommended once changes start touching multiple layers at once), plus pointers for going further: real per-user auth and a checklist for hardening this server toward production use.

### Additional resources

- [APS Viewer developer guide](https://aps.autodesk.com/en/docs/viewer/v7/developers_guide/overview/)
- [`@modelcontextprotocol/ext-apps` documentation](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
- [MCP UI resources spec](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
