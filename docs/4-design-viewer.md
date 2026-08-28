# Part 4: Embedded Viewer

In this section you'll add a tool that renders an Autodesk design in 3D directly inside the chat. Unlike the text-only tools so far, it returns an **MCP app resource**: a self-contained HTML page the MCP client loads and displays in an `<iframe>`.

## Theory

MCP Apps adds two concepts on top of the server you already have, both expressed as plain `_meta` fields on the `registerTool` and `registerResource` calls you know:

- **App resource** — an MCP resource whose body is an HTML document, identified by a `ui://` URI and marked with a `text/html;profile=mcp-app` MIME type. The client renders it in a sandboxed panel under a content security policy the server declares.
- **App tool** — a tool that names an app resource in its metadata. When the tool returns, the client shows that resource and forwards the tool's structured result to it.

The APS Viewer running inside that page needs three things: its own scripts and stylesheet from `developer.api.autodesk.com`, the design's URN, and an access token to access the design's derivatives.

## Step 1: Add viewer UI

Create `viewer.html` in the project root:

```html
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/style.min.css" type="text/css">
  <script src="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js"></script>
  <style>
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
  </style>
</head>

<body>
  <div id="viewer"></div>
  <script type="module">
    // TODO: connect to the MCP host and load the model
  </script>
</body>

</html>
```

The empty `<div>` is where the viewer mounts. `min-height` matters more than it looks: the panel the host gives you can be short, and the viewer needs a canvas with actual height to initialise into.

## Step 2: Add viewer logic

Replace the `TODO` with the inline module script:

```js
    import { App } from 'https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps@1.7.5/dist/src/app-with-deps.js';

    const app = new App({ name: 'Design Viewer', version: '1.0.0' });
    app.ontoolresult = async ({ structuredContent: { urn, config } = {} }) => {
      if (!urn || !config) return;
      if (!viewer) viewer = await initializeViewer(config);
      loadModel(viewer, urn);
    };
    app.connect();
    app.requestDisplayMode({ mode: 'pip' });

    let viewer = null;

    async function initializeViewer(config) {
      return new Promise((resolve) => {
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

    function loadModel(viewer, urn) {
      Autodesk.Viewing.Document.load(
        'urn:' + urn,
        (doc) => viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry()),
        (errorCode, errorMessage, errors) => console.error('Failed to load document:', errorCode, errorMessage, errors)
      );
    }
```

Traffic flows in both directions here:

- `app.connect()` opens the channel to the MCP host, and `ontoolresult` fires whenever the tool from Step 3 returns. Its structured payload carries the access token, the viewer configuration, and the design URN. The viewer is created on the first result and reused for later ones, so asking for a second design swaps the model instead of rebuilding the panel.
- `updateModelContext` pushes the current selection back into the AI's context. The model can then answer "what's the area of the selected slab?" without the user typing any IDs.
- `requestDisplayMode({ mode: 'pip' })` asks the host for a picture-in-picture panel rather than an inline strip — the viewer wants room.

## Step 3: Add MCP tool & resource

The tool needs one APS call the earlier parts didn't: resolving a design to its latest version and derivative URN. Add it to `aps.js`:

```js
export async function getItemTip(projectId, itemId, authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data } = await client.getItemTip(projectId, itemId);
    return {
        name: data.attributes.displayName,
        derivativeUrn: data.relationships.derivatives.data.id
    };
}
```

Now extend `mcp.js`. First the imports and module constants:

```diff
+import { readFileSync } from 'node:fs';
 import { McpServer } from '@modelcontextprotocol/server';
 import { z } from 'zod';
-import { getHubsProjects, getFolderContents } from './aps.js';
+import { getHubsProjects, getFolderContents, getItemTip } from './aps.js';
+
+const VIEWER_HTML = readFileSync(new URL('./viewer.html', import.meta.url), 'utf-8');
+
+const VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html';
+const VIEWER_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
+const VIEWER_DOMAINS = [
+    'https://developer.api.autodesk.com',
+    'https://cdn.derivative.autodesk.com',
+    'https://fonts.autodesk.com',
+];
+const VIEWER_SCRIPT_DOMAINS = ['https://cdn.jsdelivr.net'];
 
-export function createMcpServer(authenticationProvider) {
+export function createMcpServer(authenticationProvider, publicUrl) {
```

The two domain lists become the resource's content security policy. `VIEWER_DOMAINS` covers the APS endpoints the viewer fetches and streams from; `VIEWER_SCRIPT_DOMAINS` is the CDN that serves a script and never receives a connection. Keeping them apart is what lets the policy grant each origin only what it needs. The host enforces whatever the server declares, so a new external origin in `viewer.html` is blocked until you add it to the matching list.

`publicUrl` is the new second parameter, needed by the resource below.

Then register the tool and the resource, just before `return server`:

```js
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
        async ({ projectId, designId, region = 'US' }) => {
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
        }
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
                            resourceDomains: [...VIEWER_DOMAINS, ...VIEWER_SCRIPT_DOMAINS, 'blob:', 'data:'],
                            connectDomains: [...VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                        },
                    },
                },
            }]
        })
    );
```

What differs from a normal tool and a normal resource:

- `_meta.ui.resourceUri` on the tool names the panel to surface alongside its result. That single field is the entire contract between a tool and its UI.
- The handler returns **both** `structuredContent`, which `viewer.html` consumes, and a plain text block, which the user and the model read.
- The access token is fetched from the same provider the other tools use and travels inside `structuredContent`. It's short-lived and scoped to `data:read`, and it's the only APS token that ever leaves the process — the viewer needs it to fetch derivatives directly.
- The resource's read callback receives the requested `uri` and echoes it back on the content entry, which also repeats the MIME type. MCP requires each entry to carry its own URI.

## Step 4: Update index.js

The factory takes a second argument now, so pass it through:

```diff
-const mcpHandler = createMcpHandler((ctx) => createMcpServer(ctx.authInfo.extra.apsAuthenticationProvider));
+const mcpHandler = createMcpHandler((ctx) => createMcpServer(ctx.authInfo.extra.apsAuthenticationProvider, PUBLIC_URL));
```

That's the only change in `index.js`, and it's why `PUBLIC_URL` had to be threaded through from Part 2: the panel's security policy is expressed relative to the server's own public origin.

## Checkpoint

You should now have:

- [x] `viewer.html` — one self-contained document
- [x] `getItemTip` helper function in `aps.js`
- [x] `mcp.js` registering the viewer resource and the `preview-design` tool
- [x] `index.js` passing `PUBLIC_URL` to the factory

```text
.vscode/
  mcp.json
  launch.json
viewer.html
aps.js
mcp.js
proxy.js
index.js
package.json
```

<details>
    <summary>
        Reference: full <code>viewer.html</code>
    </summary>

```html
<!DOCTYPE html>
<html lang="en">

<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/style.min.css" type="text/css">
  <script src="https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*/viewer3D.min.js"></script>
  <style>
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
  </style>
</head>

<body>
  <div id="viewer"></div>
  <script type="module">
    import { App } from 'https://cdn.jsdelivr.net/npm/@modelcontextprotocol/ext-apps@1.7.5/dist/src/app-with-deps.js';

    const app = new App({ name: 'Design Viewer', version: '1.0.0' });
    app.ontoolresult = async ({ structuredContent: { urn, config } = {} }) => {
      if (!urn || !config) return;
      if (!viewer) viewer = await initializeViewer(config);
      loadModel(viewer, urn);
    };
    app.connect();
    app.requestDisplayMode({ mode: 'pip' });

    let viewer = null;

    async function initializeViewer(config) {
      return new Promise((resolve) => {
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

    function loadModel(viewer, urn) {
      Autodesk.Viewing.Document.load(
        'urn:' + urn,
        (doc) => viewer.loadDocumentNode(doc, doc.getRoot().getDefaultGeometry()),
        (errorCode, errorMessage, errors) => console.error('Failed to load document:', errorCode, errorMessage, errors)
      );
    }
  </script>
</body>

</html>
```

</details>

<details>
    <summary>
        Reference: full <code>mcp.js</code>
    </summary>

```js
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHubsProjects, getFolderContents, getItemTip } from './aps.js';

const VIEWER_HTML = readFileSync(new URL('./viewer.html', import.meta.url), 'utf-8');

const VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html';
const VIEWER_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
];
const VIEWER_SCRIPT_DOMAINS = ['https://cdn.jsdelivr.net'];

export function createMcpServer(authenticationProvider, publicUrl) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        description: 'MCP server for Autodesk Platform Services',
        version: '1.0.0'
    });

    server.registerTool(
        'list-hubs-projects',
        {
            description: 'Lists all hubs and their projects available to the authenticated user.'
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
        async ({ projectId, designId, region = 'US' }) => {
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
        }
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
                            resourceDomains: [...VIEWER_DOMAINS, ...VIEWER_SCRIPT_DOMAINS, 'blob:', 'data:'],
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
import { createMcpExpressApp, requireBearerAuth, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpServer } from './mcp.js';
import { createOAuthProxy } from './proxy.js';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
    console.error('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.');
    process.exit(1);
}
const PORT = parseInt(process.env.PORT || '3000');
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const CALLBACK_URL = `${PUBLIC_URL}/auth/callback`;

const { router: authProxyRouter, tokenVerifier } = createOAuthProxy({
    issuerUrl: new URL(PUBLIC_URL),
    resourceUrl: new URL(`${PUBLIC_URL}/mcp`),
    apsClientId: APS_CLIENT_ID,
    apsClientSecret: APS_CLIENT_SECRET,
    callbackUrl: CALLBACK_URL,
});
const mcpHandler = createMcpHandler((ctx) => createMcpServer(ctx.authInfo.extra.apsAuthenticationProvider, PUBLIC_URL));

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.use(cors());
app.use(authProxyRouter);

app.use('/mcp', requireBearerAuth({
    verifier: tokenVerifier,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(`${PUBLIC_URL}/mcp`)),
}));

const mcpNodeHandler = toNodeHandler(mcpHandler);
app.all('/mcp', (req, res) => mcpNodeHandler(req, res, req.body));

app.listen(PORT, () => console.log(`MCP server listening on ${PUBLIC_URL}/mcp`));
```

</details>

### Try it out

1. Restart the server, then reconnect the MCP server entry in VS Code so it picks up the new tool.
2. In Copilot Chat (agent mode), ask for a preview:

   > Open one of my Forma designs in the viewer.

3. Copilot will usually chain calls: `list-hubs-projects` → `list-folder-contents` → `preview-design`. Approve the tool prompts.
4. The viewer panel appears with the model loaded. Select an object — the chat now knows what's selected and can answer follow-up questions about it.

> **Restart after editing the viewer.** The HTML is read once at startup, so an edit to `viewer.html` is invisible until you restart the server.

> **Blank panel?** Open the panel's developer tools and look for content security policy errors. Any origin the page reaches that isn't in `VIEWER_DOMAINS` or `VIEWER_SCRIPT_DOMAINS` is blocked by the host.

### Where next?

You now have an HTTP MCP server that only signed-in MCP clients can reach, that acts as a real Autodesk user, and that can render designs in 3D inside the chat — the core mechanics behind any AI assistant working on a user's Autodesk data. [Extras](extras.md) covers spec-driven development with GitHub Spec-Kit, a production-grade alternative to the workshop's OAuth proxy, and a checklist for hardening the rest.

### Additional resources

- [APS Viewer developer guide](https://aps.autodesk.com/en/docs/viewer/v7/developers_guide/overview/)
- [`@modelcontextprotocol/ext-apps` documentation](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
- [MCP resources specification](https://modelcontextprotocol.io/specification/2026-07-28/server/resources)
