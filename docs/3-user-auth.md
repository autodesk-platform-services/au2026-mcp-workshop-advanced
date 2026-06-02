# Part 3: User Authentication

In this section you'll swap the 2-legged `AppAuthenticationProvider` for a `UserAuthenticationProvider` that holds a real user's access + refresh tokens. The HTTP transport from Part 2 makes this practical: each browser session gets its own provider, and a new `/auth/callback` route on the Express app completes the OAuth dance. The data helpers (`getHubsProjects`, `getFolderContents`) stay exactly as they are — both providers expose the same `getAccessToken()` interface, which is the whole reason the provider pattern exists.

## Theory

### Why 3-legged?

2-legged tokens are issued *to your application*. They are great for service-to-service automation, but they cannot see anything a Forma user owns unless the hub administrator explicitly delegates it. As soon as the AI should "act as the user" — show their projects, their permissions, files they personally have access to — you need a **3-legged** token.

The flow is:

1. Send the user to `https://developer.api.autodesk.com/authentication/v2/authorize` with your client ID, the requested scopes, a redirect URL, and a `state` value.
2. The user signs in and consents. Autodesk redirects back to your callback URL with a one-time `code`.
3. Your server exchanges the `code` (plus client secret) for an `access_token` and a `refresh_token`.
4. The access token expires after about an hour. Use the refresh token to mint new ones without prompting the user again.

### Per-session providers

In Part 2 the whole process shared a single `AppAuthenticationProvider`. With user tokens that won't work — each session must hold its own credentials. We'll keep a single `sessions` map keyed by session ID, where each entry bundles that session's transport **and** its own `UserAuthenticationProvider`. The session ID doubles as the OAuth `state` parameter, so the callback knows which provider to populate.

### Login URL elicitation — and the fallback

MCP defines an "elicit input" capability that lets a server ask the client (Copilot) to open a URL on the user's behalf. Today, GitHub Copilot does **not** implement URL elicitation. So instead of relying on it, we return the authorization URL as plain text inside the first tool result and let the user click it manually. The mechanism is crude but works in every MCP client.

## Step 1: User authentication provider

Open `aps.js` and replace the imports + `AppAuthenticationProvider` class with the user-level equivalent:

```js
import { AuthenticationClient, Scopes, ResponseType } from '@aps_sdk/authentication';
import { DataManagementClient } from '@aps_sdk/data-management';

const SCOPES = [Scopes.DataRead];

export class UserAuthenticationProvider {
    constructor(clientId, clientSecret, callbackUrl) {
        this.authClient = new AuthenticationClient();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.callbackUrl = callbackUrl;
        this.cache = {
            accessToken: null,
            refreshToken: null,
            expiresAt: 0
        };
    }

    isAuthenticated() {
        return !!this.cache.accessToken && this.cache.expiresAt > Date.now();
    }

    async refreshAccessToken(refreshToken) {
        const credentials = await this.authClient.refreshToken(refreshToken, this.clientId, { clientSecret: this.clientSecret });
        this.cache.accessToken = credentials.access_token;
        this.cache.refreshToken = credentials.refresh_token;
        this.cache.expiresAt = Date.now() + credentials.expires_in * 1000;
    }

    async getAccessToken() {
        if (this.cache.accessToken && this.cache.expiresAt > Date.now()) {
            return this.cache.accessToken;
        } else if (this.cache.refreshToken) {
            await this.refreshAccessToken(this.cache.refreshToken);
            return this.cache.accessToken;
        } else {
            throw new Error('Not authenticated');
        }
    }
}
```

Each instance creates its own `AuthenticationClient`. Unlike the beginner's `AppAuthenticationProvider`, there is no module-level shared client — each user session is independent.

Key differences from the beginner provider:

- The cache holds **both** an access token (short-lived) and a refresh token (long-lived).
- `isAuthenticated()` checks that the token both exists and hasn't expired. The MCP server calls this to decide whether to return a login URL instead of running the tool.
- `getAccessToken()` returns the cached token, refreshes it silently using the refresh token, or throws `Not authenticated` if the user hasn't completed OAuth yet.

## Step 2: Authorization URL & code exchange

Add these two methods to `UserAuthenticationProvider`:

```js
getAuthorizationUrl(state) {
    return this.authClient.authorize(this.clientId, ResponseType.Code, this.callbackUrl, SCOPES, { state });
}

async exchangeAuthCode(code) {
    const credentials = await this.authClient.getThreeLeggedToken(this.clientId, code, this.callbackUrl, { clientSecret: this.clientSecret });
    this.cache.accessToken = credentials.access_token;
    this.cache.refreshToken = credentials.refresh_token;
    this.cache.expiresAt = Date.now() + credentials.expires_in * 1000;
}
```

- `getAuthorizationUrl(state)` builds the redirect URL using the `callbackUrl` stored at construction time. `state` is the MCP session ID — the OAuth server sends it back to the callback so we know which provider to populate.
- `exchangeAuthCode(code)` swaps the one-time `code` for access + refresh tokens and stores them directly in `this.cache`. The callback URL is already on the instance, so `index.js` only needs to pass the code.

## Step 3: Keep the data helpers, add `getItemTip`

The existing `getHubsProjects` and `getFolderContents` functions are unchanged — both `AppAuthenticationProvider` and `UserAuthenticationProvider` satisfy the `{ getAccessToken() }` interface that `DataManagementClient` expects.

While you're here, add one more helper that Part 4 will need: `getItemTip` returns the latest version's name and derivative URN for a design.

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

## Step 4: Login-gated tool handlers

A 3-legged session has no tokens until the user has logged in. The MCP tools need to detect that and respond with the authorization URL instead of crashing with `Not authenticated`.

Update `mcp.js` so the factory accepts the login URL alongside the auth provider, and wraps each handler in a small `withAuth` helper that short-circuits to a login prompt when the session isn't authenticated yet:

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getHubsProjects, getFolderContents } from './aps.js';

export function createMcpServer(authenticationProvider, authUrl) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        description: 'MCP server for Autodesk Platform Services',
        version: '1.0.0'
    });

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

    return server;
}
```

The factory now **receives** the login URL — `index.js` computes it once (Step 5) and passes it in, keeping the factory free of session bookkeeping. The `withAuth` wrapper guards every tool in one place: when the session isn't yet authenticated it returns a short message containing the login URL for the AI to show the user; otherwise it runs the real handler.

## Step 5: Per-session providers + callback route

The HTTP entry point from Part 2 used one shared `AppAuthenticationProvider`. Refactor it so each session gets its own `UserAuthenticationProvider` and login URL, and add the `/auth/callback` route that completes the OAuth exchange:

```js
import crypto from 'crypto';
import cors from 'cors';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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

const sessions = new Map();

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.use(cors());

app.all('/mcp', async (req, res) => {
    let sessionId = req.headers['mcp-session-id'];

    try {
        if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId);
            await transport.handleRequest(req, res, req.body);
        } else if (!sessionId && isInitializeRequest(req.body)) {
            sessionId = crypto.randomUUID();
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
            const authProvider = new UserAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET, CALLBACK_URL);
            sessions.set(sessionId, { transport, authProvider });
            transport.onclose = () => sessions.delete(sessionId);
            const authUrl = authProvider.getAuthorizationUrl(sessionId);
            const server = createMcpServer(authProvider, authUrl);
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                id: null,
            });
        }
    } catch (err) {
        console.error('MCP error:', err);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            });
        }
    }
});

app.get('/auth/callback', async (req, res) => {
    const { code, state: sessionId } = req.query;
    if (!code || !sessionId) return res.status(400).send('Missing code or state parameter.');
    if (!sessions.has(sessionId)) return res.status(400).send('Invalid or expired session ID.');
    try {
        const { authProvider } = sessions.get(sessionId);
        await authProvider.exchangeAuthCode(code);
        res.send('Login successful! You can close this window and return to your AI assistant.');
    } catch (err) {
        console.error('Auth callback error:', err);
        res.status(500).send('Authentication failed.');
    }
});

app.listen(PORT, () => console.log(`MCP server listening on ${PUBLIC_URL}/mcp`));
```

The diff from Part 2:

- The single `transports` map becomes a `sessions` map whose entries each bundle a transport with that session's own `UserAuthenticationProvider`.
- We generate the session ID up front with `crypto.randomUUID()` and feed it to `sessionIdGenerator`. Because the ID is known synchronously we build the provider, derive its login URL with `getAuthorizationUrl(sessionId)`, and register the session immediately — no `onsessioninitialized` callback needed. `transport.onclose` deletes the session.
- A request whose `mcp-session-id` header matches a stored session is served from that session's transport. A request with no session header is allowed through only if it is an `initialize` request (`isInitializeRequest`); anything else gets a `400` JSON-RPC error.
- The provider is constructed with the callback URL baked in (`CALLBACK_URL`), and the entry point passes the login URL into the factory via `createMcpServer(authProvider, authUrl)` — the factory itself stays out of session bookkeeping.
- The `try/catch` replies with a `500` JSON-RPC error (guarded by `res.headersSent`) instead of leaking the exception.
- A new `/auth/callback` route resolves the right provider from the `sessions` map via the `state` parameter and calls `authProvider.exchangeAuthCode(code)`. No callback URL argument is needed because it was stored at construction time.

## Checkpoint

You should now have:

- [x] `UserAuthenticationProvider` (with `getAuthorizationUrl` and `exchangeAuthCode` as instance methods) and `getItemTip` in `aps.js`
- [x] `mcp.js` with a `withAuth` wrapper guarding both tool handlers
- [x] `index.js` allocating per-session auth providers and serving `/auth/callback`

<details>
    <summary>
        Reference: full <code>aps.js</code>
    </summary>

```js
import { AuthenticationClient, Scopes, ResponseType } from '@aps_sdk/authentication';
import { DataManagementClient } from '@aps_sdk/data-management';

const SCOPES = [Scopes.DataRead];

export class UserAuthenticationProvider {
    constructor(clientId, clientSecret, callbackUrl) {
        this.authClient = new AuthenticationClient();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.callbackUrl = callbackUrl;
        this.cache = {
            accessToken: null,
            refreshToken: null,
            expiresAt: 0
        };
    }

    isAuthenticated() {
        return !!this.cache.accessToken && this.cache.expiresAt > Date.now();
    }

    getAuthorizationUrl(state) {
        return this.authClient.authorize(this.clientId, ResponseType.Code, this.callbackUrl, SCOPES, { state });
    }

    async exchangeAuthCode(code) {
        const credentials = await this.authClient.getThreeLeggedToken(this.clientId, code, this.callbackUrl, { clientSecret: this.clientSecret });
        this.cache.accessToken = credentials.access_token;
        this.cache.refreshToken = credentials.refresh_token;
        this.cache.expiresAt = Date.now() + credentials.expires_in * 1000;
    }

    async refreshAccessToken(refreshToken) {
        const credentials = await this.authClient.refreshToken(refreshToken, this.clientId, { clientSecret: this.clientSecret });
        this.cache.accessToken = credentials.access_token;
        this.cache.refreshToken = credentials.refresh_token;
        this.cache.expiresAt = Date.now() + credentials.expires_in * 1000;
    }

    async getAccessToken() {
        if (this.cache.accessToken && this.cache.expiresAt > Date.now()) {
            return this.cache.accessToken;
        } else if (this.cache.refreshToken) {
            await this.refreshAccessToken(this.cache.refreshToken);
            return this.cache.accessToken;
        } else {
            throw new Error('Not authenticated');
        }
    }
}

export async function getHubsProjects(authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data: hubs = [] } = await client.getHubs();
    return Promise.all(hubs.map(async hub => {
        const { data: projects = [] } = await client.getHubProjects(hub.id);
        return {
            id: hub.id,
            name: hub.attributes.name,
            region: hub.attributes.region,
            projects: projects.map(p => ({ id: p.id, name: p.attributes.name }))
        };
    }));
}

export async function getFolderContents(hubId, projectId, folderId, authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data: items = [] } = folderId
        ? await client.getFolderContents(projectId, folderId)
        : await client.getProjectTopFolders(hubId, projectId);
    return items.map(item => ({
        type: item.type,
        id: item.id,
        name: item.attributes.displayName,
        modifiedAt: item.attributes.lastModifiedTime,
        modifiedBy: item.attributes.lastModifiedUserName
    }));
}

export async function getItemTip(projectId, itemId, authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data } = await client.getItemTip(projectId, itemId);
    return {
        name: data.attributes.displayName,
        derivativeUrn: data.relationships.derivatives.data.id
    };
}
```

</details>

<details>
    <summary>
        Reference: full <code>mcp.js</code>
    </summary>

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getHubsProjects, getFolderContents } from './aps.js';

export function createMcpServer(authenticationProvider, authUrl) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        description: 'MCP server for Autodesk Platform Services',
        version: '1.0.0'
    });

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

    return server;
}
```

</details>

<details>
    <summary>
        Reference: full <code>index.js</code>
    </summary>

```js
import crypto from 'crypto';
import cors from 'cors';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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

const sessions = new Map();

const app = createMcpExpressApp({ host: '0.0.0.0' });
app.use(cors());

app.all('/mcp', async (req, res) => {
    let sessionId = req.headers['mcp-session-id'];

    try {
        if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId);
            await transport.handleRequest(req, res, req.body);
        } else if (!sessionId && isInitializeRequest(req.body)) {
            sessionId = crypto.randomUUID();
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => sessionId });
            const authProvider = new UserAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET, CALLBACK_URL);
            sessions.set(sessionId, { transport, authProvider });
            transport.onclose = () => sessions.delete(sessionId);
            const authUrl = authProvider.getAuthorizationUrl(sessionId);
            const server = createMcpServer(authProvider, authUrl);
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } else {
            res.status(400).json({
                jsonrpc: '2.0',
                error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
                id: null,
            });
        }
    } catch (err) {
        console.error('MCP error:', err);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: '2.0',
                error: { code: -32603, message: 'Internal server error' },
                id: null,
            });
        }
    }
});

app.get('/auth/callback', async (req, res) => {
    const { code, state: sessionId } = req.query;
    if (!code || !sessionId) return res.status(400).send('Missing code or state parameter.');
    if (!sessions.has(sessionId)) return res.status(400).send('Invalid or expired session ID.');
    try {
        const { authProvider } = sessions.get(sessionId);
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

### Try it out

1. Restart the server: `npm start`.
2. In VS Code, open a fresh Copilot Chat (a new chat triggers a new MCP session, which is what you want).
3. Ask: *"What Forma projects do I have access to?"*
4. The first tool call returns the "Authentication required" message with a URL.
5. Open the URL in a browser, sign in with your Autodesk account, and see the *"Login successful!"* page.
6. Re-run the same prompt. The tool now returns the hubs and projects that **your user** can see — which may differ from the application-level results you got in Part 2.

> **Multiple sessions.** Open a second Copilot Chat to confirm sessions are independent. The second one will demand its own login URL because its session ID and auth provider are new.

### Additional resources

- [APS 3-legged OAuth tutorial](https://aps.autodesk.com/en/docs/oauth/v2/tutorials/get-3-legged-token/)
- [APS Authentication API reference](https://aps.autodesk.com/en/docs/oauth/v2/reference/http/)
