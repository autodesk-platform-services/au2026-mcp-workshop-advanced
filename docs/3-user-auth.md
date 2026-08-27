# Part 3: User Authentication

In this section you'll swap the 2-legged `AppAuthenticationProvider` for a `UserAuthenticationProvider` that holds a real user's access + refresh tokens. To keep the workshop focused on the OAuth mechanics rather than session bookkeeping, a single shared `UserAuthenticationProvider` instance serves the whole process — exactly like `AppAuthenticationProvider` did in Part 2 — and a new `/auth/callback` route on the Express app completes the OAuth dance. The data helpers (`getHubsProjects`, `getFolderContents`) stay exactly as they are — both providers expose the same `getAccessToken()` interface, which is the whole reason the provider pattern exists.

## Theory

### Why 3-legged?

2-legged tokens are issued *to your application*. They are great for service-to-service automation, but they cannot see anything a Forma user owns unless the hub administrator explicitly delegates it. As soon as the AI should "act as the user" — show their projects, their permissions, files they personally have access to — you need a **3-legged** token.

The flow is:

1. Send the user to `https://developer.api.autodesk.com/authentication/v2/authorize` with your client ID, the requested scopes, a redirect URL, and a `state` value.
2. The user signs in and consents. Autodesk redirects back to your callback URL with a one-time `code`.
3. Your server exchanges the `code` (plus client secret) for an `access_token` and a `refresh_token`.
4. The access token expires after about an hour. Use the refresh token to mint new ones without prompting the user again.

### One shared provider (for now)

In Part 2 the whole process shared a single `AppAuthenticationProvider`. This workshop keeps that shape for `UserAuthenticationProvider` too: one instance, constructed once in `index.js`, closed over by every `McpServer` the `createMcpHandler` factory builds. Whoever completes the OAuth login populates the tokens that *every* request then sees through `getAccessToken()`.

That's a deliberate simplification, not an oversight. It keeps this part of the tutorial about the 3-legged OAuth flow itself — authorize, redirect, exchange, refresh — without also teaching a second, unrelated problem: how to know *which* human is behind a given HTTP request. Real multi-user support needs an answer to that question, and bolting it on with nothing but a random MCP session ID (which resets every time a client reconnects) would be more confusing than illuminating.

> **Design note: getting to real multi-user auth.** MCP already has a name for the piece this workshop skips: the [MCP Authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) describes a **Layer 1** handshake between the MCP client and the MCP server, separate from whatever APIs the server calls on the user's behalf. In that model, an MCP server is an OAuth 2.1 resource server sitting in front of its own authorization server — one that supports [Client ID Metadata Documents (CIMD)](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) so MCP clients can identify themselves without manual pre-registration. The authorization server issues the MCP client a token carrying a stable user identity (a `sub` claim), and the MCP server validates that token on every request.
>
> Once you have that stable, per-request user ID from Layer 1, per-user APS auth (**Layer 2**, what this part of the tutorial builds) becomes a lookup instead of a guess: keep a `Map<userId, UserAuthenticationProvider>`, resolve the current request's user ID from its validated Layer 1 token, and get-or-create that user's provider from the map. The MCP session ID is no longer part of the equation — sessions can come and go, but a user's `UserAuthenticationProvider` (and their APS refresh token) persists as long as the process does, keyed by an identity that doesn't change on reconnect. Running a real, CIMD-enabled authorization server is out of scope for this workshop — see [Extras](extras.md) for pointers if you want to take this further.

[Part 5](5-client-auth.md) builds this Layer 1 piece — a small, self-hosted OAuth proxy in front of `/mcp` that uses APS itself as the authorization server, instead of a third-party identity provider.

### Login URL elicitation — and the fallback

MCP defines an "elicit input" capability that lets a server ask the client (Copilot) to open a URL on the user's behalf. Today, GitHub Copilot does **not** implement URL elicitation. So instead of relying on it, we return the authorization URL as plain text inside the first tool result and let the user click it manually. The mechanism is crude but works in every MCP client.

[Part 5](5-client-auth.md) removes this fallback entirely — once `/mcp` itself requires OAuth, an MCP client that supports standard authorization discovery opens a normal browser sign-in prompt on its own, with no manually-clicked link required.

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

The shape is deliberately close to the beginner's `AppAuthenticationProvider`: same per-instance `AuthenticationClient`, same in-memory cache, same `getAccessToken()`. The constructor takes one extra argument — `callbackUrl` — because a 3-legged flow has to tell Autodesk where to send the user back.

Key differences from the beginner provider:

- The cache holds **both** an access token (short-lived) and a refresh token (long-lived).
- `isAuthenticated()` checks that the token both exists and hasn't expired. The MCP server calls this to decide whether to return a login URL instead of running the tool.
- `getAccessToken()` returns the cached token, refreshes it silently using the refresh token, or throws `Not authenticated` if the user hasn't completed OAuth yet.

## Step 2: Authorization URL & code exchange

Add these two methods to `UserAuthenticationProvider`:

```js
getAuthorizationUrl() {
    return this.authClient.authorize(this.clientId, ResponseType.Code, this.callbackUrl, SCOPES);
}

async exchangeAuthCode(code) {
    const credentials = await this.authClient.getThreeLeggedToken(this.clientId, code, this.callbackUrl, { clientSecret: this.clientSecret });
    this.cache.accessToken = credentials.access_token;
    this.cache.refreshToken = credentials.refresh_token;
    this.cache.expiresAt = Date.now() + credentials.expires_in * 1000;
}
```

- `getAuthorizationUrl()` builds the redirect URL using the `callbackUrl` stored at construction time. There's no `state` parameter to thread through, because there's only one provider instance for the callback to populate — see the design note above for what a real, per-user version of this would need.
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

Update `mcp.js` so the factory computes the login URL itself and wraps each handler in a small `withAuth` helper that short-circuits to a login prompt when the session isn't authenticated yet:

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

    return server;
}
```

The factory now computes its own login URL via `authenticationProvider.getAuthorizationUrl()` — that method only builds a URL string (no network call), so recomputing it every time `createMcpHandler` calls the factory is cheap, and `index.js` never needs to know the login URL exists. The `withAuth` wrapper guards every tool in one place: when the session isn't yet authenticated it returns a short message containing the login URL for the AI to show the user; otherwise it runs the real handler.

## Step 5: Update the entry point

Swap `AppAuthenticationProvider` for `UserAuthenticationProvider` and add the `/auth/callback` route that completes the OAuth exchange. Nothing about the `createMcpHandler` / `toNodeHandler` wiring from Part 2 changes — it never depended on which auth provider the factory closes over:

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
const mcpHandler = createMcpHandler(() => createMcpServer(authProvider));

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

The diff from Part 2:

- `AppAuthenticationProvider` becomes `UserAuthenticationProvider`, now constructed with a `CALLBACK_URL` so it knows where to send Autodesk's redirect.
- `createMcpExpressApp`, `createMcpHandler`, `toNodeHandler`, and the `/mcp` route are untouched — the factory closure is the only place that knows about the auth provider, so swapping it there is enough.
- A new `/auth/callback` route reads the `code` query parameter and calls `authProvider.exchangeAuthCode(code)` — there's no session or state lookup, because there's only one provider to populate.

Whoever completes the login at the URL `createMcpServer` handed back authenticates the whole server, for every current and future request, until the access and refresh tokens expire or the process restarts. That's the tradeoff this part's design note calls out — fine for a workshop where one attendee runs one server, not what you'd ship to production. It's worth noting this cuts both ways in the design note's Layer 1 story too: a real per-request bearer token doesn't need a session ID either — the token rides on every request, so the identity lookup (and the handler underneath it) can stay just as stateless as it is here.

## Checkpoint

You should now have:

- [x] `UserAuthenticationProvider` (with `getAuthorizationUrl` and `exchangeAuthCode` as instance methods) and `getItemTip` in `aps.js`
- [x] `mcp.js` with a `withAuth` wrapper guarding both tool handlers
- [x] `index.js` building one shared auth provider and serving `/auth/callback`

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

    getAuthorizationUrl() {
        return this.authClient.authorize(this.clientId, ResponseType.Code, this.callbackUrl, SCOPES);
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
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHubsProjects, getFolderContents } from './aps.js';

export function createMcpServer(authenticationProvider) {
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
const mcpHandler = createMcpHandler(() => createMcpServer(authProvider));

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

### Try it out

1. Restart the server: `npm start`.
2. In VS Code, open a fresh Copilot Chat (a new chat won't have a cached tool result, so it actually calls the tool instead of reusing an old answer).
3. Ask: *"What Forma projects do I have access to?"*
4. The first tool call returns the "Authentication required" message with a URL.
5. Open the URL in a browser, sign in with your Autodesk account, and see the *"Login successful!"* page.
6. Re-run the same prompt. The tool now returns the hubs and projects that **your user** can see — which may differ from the application-level results you got in Part 2.

> **Multiple chats.** Open a second Copilot Chat and ask the same question straight away — no second login required. That's the shared-provider tradeoff from this part's design note: every chat sees whichever user last completed the OAuth login, because there's only one `UserAuthenticationProvider` for the whole process. Restarting the server clears the login for everyone, not just one chat.

### Additional resources

- [APS 3-legged OAuth tutorial](https://aps.autodesk.com/en/docs/oauth/v2/tutorials/get-3-legged-token/)
- [APS Authentication API reference](https://aps.autodesk.com/en/docs/oauth/v2/reference/http/)
- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [OAuth Client ID Metadata Documents (draft)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)
