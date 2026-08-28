# Part 3: Authentication

In this section you'll make the server act on behalf of a real Autodesk user instead of as the application, and lock `/mcp` so only a signed-in MCP client can reach it. By the end, both hops of the conversation are authenticated: the client signs in to your server, and your server calls APS on the user's behalf.

## Theory

### Two hops, two OAuth flows

There are two independent trust boundaries here:

- **Your server → APS.** A 3-legged OAuth flow that gets a token representing *a signed-in Autodesk user*, so the tools return that user's hubs, projects and files.
- **MCP client → your server.** A separate OAuth flow that answers "who is calling `/mcp`?". Right now the endpoint is wide open to anyone who can reach the port, which is a problem the moment it holds a user's session.

The 3-legged flow runs like this:

1. Send the user to Autodesk's authorization page with your client ID, the scopes you want, and a callback URL.
2. The user signs in and consents. Autodesk redirects back to the callback URL with a one-time `code`.
3. Your server exchanges the `code` for an access token and a refresh token.
4. The access token is only valid for a limited time (typically an hour). The refresh token mints new ones without prompting the user again.

### Why the server needs its own OAuth endpoints

An MCP client that hits a protected `/mcp` expects a `401` telling it where to sign in, and then expects to identify itself to that authorization server without anyone registering it by hand. APS can do neither: it has never heard of your MCP client and won't issue tokens to it.

So our server takes on the role itself. It advertises its own authorization and token endpoints, runs the user through Autodesk's real sign-in page behind the scenes, and hands the MCP client its own generated credentials — while the actual APS tokens stay on the server. That's what `proxy.js` does in Step 2.

> **Design note: this is a workshop stand-in, not production-ready.** The proxy you're about to write trades away most of what a real authorization server does: no persistence, no PKCE verification, no client authentication at the token endpoint, no rate limiting, no revocation, no rotation on refresh. All state lives in memory. That's a deliberate trade of robustness for a file you can read in one sitting — don't ship it as-is. A real deployment either builds a purpose-fit proxy with the missing checks, or integrates a dedicated identity provider (Auth0, Okta, Entra ID, …). [Extras](extras.md) links a full reference implementation built on Auth0.

## Step 1: User authentication provider

In `aps.js`, update the imports and replace `AppAuthenticationProvider` with a user-level provider:

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
```

The class covers the three steps of the 3-legged flow that touch APS. `getAuthorizationUrl` builds the sign-in link (it makes no network call), `exchangeAuthCode` turns the one-time code into a token pair, and `getAccessToken` hands out the cached access token, refreshing it silently when it has expired.

Two properties carry the rest of the design:

- The cache holds an access token *and* a refresh token, so a session survives the token expiration without another sign-in.
- `getAccessToken()` is the only method anything outside this class calls for a token, and it returns the same thing the 2-legged provider did. `getHubsProjects` and `getFolderContents` therefore need no changes — they still receive `{ authenticationProvider }` and let the SDK ask for a token when it needs one.

## Step 2: OAuth proxy

This step is a shortcut. Every other file in the workshop grows a few lines at a time, but an OAuth flow has no useful halfway point — until all four routes exist, none of them do anything you can test. So create `proxy.js` at the project root, paste the whole file in, and read the tour that follows it. One factory, four routes, about 100 lines:

```js
// Demo-only OAuth proxy for this workshop: in-memory, no PKCE or client authentication, and missing most other production checks — replace it with a purpose-built implementation or a third-party identity provider before shipping.

import express from 'express';
import { randomBytes } from 'node:crypto';
import { mcpAuthMetadataRouter } from '@modelcontextprotocol/express';
import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';
import { UserAuthenticationProvider } from './aps.js';

const TOKEN_TTL_MS = 60 * 60 * 1000;
const generateToken = () => randomBytes(32).toString('base64url');

const cimdCache = new Map();
async function resolveClient(clientId) {
    if (typeof clientId !== 'string' || !clientId.startsWith('https://')) return undefined;
    if (!cimdCache.has(clientId)) {
        cimdCache.set(clientId, await fetch(clientId).then((r) => r.json()));
    }
    return cimdCache.get(clientId);
}

function isRegisteredRedirectUri(requested, client) {
    return typeof requested === 'string' && (client.redirect_uris ?? []).includes(requested);
}

export function createOAuthProxy({ issuerUrl, resourceUrl, apsClientId, apsClientSecret, callbackUrl }) {
    const pendingAuthorizations = new Map();
    const issuedCodes = new Map();
    const sessions = new Map();
    const refreshTokens = new Map();

    function issueTokens(clientId, apsProvider) {
        const accessToken = generateToken();
        const refreshToken = generateToken();
        sessions.set(accessToken, { clientId, apsProvider, expiresAt: Date.now() + TOKEN_TTL_MS });
        refreshTokens.set(refreshToken, { clientId, apsProvider });
        return { access_token: accessToken, token_type: 'bearer', expires_in: TOKEN_TTL_MS / 1000, refresh_token: refreshToken };
    }

    const router = express.Router();
    router.use(express.urlencoded({ extended: false }));

    router.use(mcpAuthMetadataRouter({
        oauthMetadata: {
            issuer: issuerUrl.href,
            authorization_endpoint: new URL('/authorize', issuerUrl).href,
            token_endpoint: new URL('/token', issuerUrl).href,
            response_types_supported: ['code'],
            grant_types_supported: ['authorization_code', 'refresh_token'],
            code_challenge_methods_supported: ['S256'],
            token_endpoint_auth_methods_supported: ['none'],
            client_id_metadata_document_supported: true,
        },
        resourceServerUrl: resourceUrl,
    }));

    router.get('/authorize', async (req, res) => {
        const { client_id: clientId, redirect_uri: redirectUri, state } = req.query;
        const client = await resolveClient(clientId);
        if (!client || !isRegisteredRedirectUri(redirectUri, client)) {
            res.status(400).json({ error: 'invalid_request', error_description: 'Unknown client_id or redirect_uri.' });
            return;
        }
        const correlationId = generateToken();
        const apsProvider = new UserAuthenticationProvider(apsClientId, apsClientSecret, callbackUrl);
        pendingAuthorizations.set(correlationId, { clientId, redirectUri, state, apsProvider });
        res.redirect(`${apsProvider.getAuthorizationUrl()}&state=${correlationId}`);
    });

    router.get('/auth/callback', async (req, res) => {
        const { code, state: correlationId } = req.query;
        try {
            const { clientId, redirectUri, state, apsProvider } = pendingAuthorizations.get(correlationId);
            pendingAuthorizations.delete(correlationId);
            await apsProvider.exchangeAuthCode(code);

            const mcpCode = generateToken();
            issuedCodes.set(mcpCode, { clientId, apsProvider });

            const redirectUrl = new URL(redirectUri);
            redirectUrl.searchParams.set('code', mcpCode);
            if (state) redirectUrl.searchParams.set('state', state);
            res.redirect(redirectUrl.toString());
        } catch (err) {
            console.error('Auth callback error:', err);
            res.status(500).send('Authentication failed.');
        }
    });

    router.post('/token', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const { grant_type: grantType, code, refresh_token: refreshToken } = req.body;
        if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
            res.status(400).json({ error: 'unsupported_grant_type', error_description: `Unsupported grant type: ${grantType}.` });
            return;
        }
        const grant = grantType === 'authorization_code' ? issuedCodes.get(code) : refreshTokens.get(refreshToken);
        if (!grant) {
            res.status(400).json({ error: 'invalid_grant', error_description: 'Unknown or expired grant.' });
            return;
        }
        if (grantType === 'authorization_code') issuedCodes.delete(code);
        res.json(issueTokens(grant.clientId, grant.apsProvider));
    });

    return {
        router,
        tokenVerifier: {
            async verifyAccessToken(token) {
                const session = sessions.get(token);
                if (!session) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Invalid token.');
                return {
                    token,
                    clientId: session.clientId,
                    scopes: [],
                    expiresAt: Math.floor(session.expiresAt / 1000),
                    extra: { apsAuthenticationProvider: { getAccessToken: () => session.apsProvider.getAccessToken() } },
                };
            },
        },
    };
}
```

Read the rest of this step as a tour of what you just pasted, not as a template to copy into a product. The comment on the first line is the point: this file stands in for an identity provider so that the workshop has one, and the Design note above lists what it leaves out. Anything beyond a demo needs a purpose-built proxy or a real IdP in its place.

### The routes, in the order a login visits them

| Route | Who calls it | What it does |
| --- | --- | --- |
| the two `.well-known` documents | the MCP client, after a `401` | advertise the endpoints below |
| `/authorize` | the MCP client's browser | identify the client, then redirect to Autodesk's sign-in page |
| `/auth/callback` | APS, after the user signs in | complete the APS exchange, hand the client a one-time code |
| `/token` | the MCP client | swap that code — or a refresh token — for tokens *this* server minted |

`mcpAuthMetadataRouter` serves the two discovery documents for you: `/.well-known/oauth-protected-resource/mcp` (derived from `resourceServerUrl`), and `/.well-known/oauth-authorization-server`, serving the `oauthMetadata` object verbatim.

`/authorize` creates a fresh `UserAuthenticationProvider` per MCP client login, stashes it under a random correlation ID, and sends the browser to Autodesk — reusing the callback URL you registered in Part 2. Note there are two `state` values in play. The MCP client's own `state` is stored untouched, to be handed back at the end of the flow; the `state` on the APS URL is our correlation ID, which is how `/auth/callback` finds its way back to the pending login.

`/auth/callback` is the hinge between the two OAuth flows. It completes the APS OAuth flow, caches the APS credentials internally, mints *its own* authorization code, and redirects the browser back to the original callback URL specified by the MCP client.

`/token` is where the MCP client can exchange the temporary code from our proxy server for an "MCP token". This token is completely separate from the cached APS credentials, exactly as the MCP specification requires.

### Who identifies the client

An MCP client's `client_id` is an HTTPS URL it controls, pointing at a small JSON document that describes it — including the `redirect_uris` it is allowed to use. `resolveClient` fetches that URL the first time it sees it, caches the result, and treats it as the client's registration. That's [Client ID Metadata Documents (CIMD)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00), and it's why nothing here needs manual pre-registration.

### What the four maps hold

| Map | Key | Value |
| --- | --- | --- |
| `pendingAuthorizations` | correlation ID | `{ clientId, redirectUri, state, apsProvider }` — a login in flight at APS |
| `issuedCodes` | MCP authorization code | `{ clientId, apsProvider }` — redeemable once, at `/token` |
| `sessions` | MCP access token | `{ clientId, apsProvider, expiresAt }` |
| `refreshTokens` | MCP refresh token | `{ clientId, apsProvider }` |

### Handing the session to the tools

`tokenVerifier` is the piece the bearer-auth guard in Step 4 calls on every request. It looks the "MCP token" up, throws `OAuthError` when there's no session (which the guard turns into a `401` with a `WWW-Authenticate` challenge), and otherwise describes the session. `expiresAt` is mandatory: the guard rejects any token whose expiry is unset.

`extra` is how the session reaches the rest of the app. Since the verifier has already found it, it attaches what the tool handlers need — a `getAccessToken()` bound to this login — rather than making them look it up again. Step 4 unwraps it.

## Step 3: Tool descriptions in `mcp.js`

The tools now report on a person rather than an application, so say so:

```diff
     server.registerTool(
         'list-hubs-projects',
         {
-            description: 'Lists all hubs and their projects available to the APS application.'
+            description: 'Lists all hubs and their projects available to the authenticated user.'
         },
```

That's the only edit `mcp.js` needs. `createMcpServer(authenticationProvider)` keeps its signature and both tool handlers stay exactly as they were — the payoff of the shared `getAccessToken()` interface. The provider is about to start coming from a per-request OAuth session instead of a process-wide object, and no code that *uses* it has to know.

## Step 4: Update the entry point

Replace `index.js`:

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
const mcpHandler = createMcpHandler((ctx) => createMcpServer(ctx.authInfo.extra.apsAuthenticationProvider));

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

The diff from Part 2:

- No auth provider is constructed here any more. `createOAuthProxy` owns them, one per login, and `PUBLIC_URL` is now load-bearing: it's the issuer the metadata advertises and the base of the callback URL you registered with APS.
- The handler's factory is called per request, and reaches into the auth info the guard below attached to pull out this login's APS session — the bound `getAccessToken()` the proxy put on `authInfo.extra`. That object is all `mcp.js` ever sees; the provider instance, and the raw APS tokens it caches, stay in `proxy.js`.
- `app.use(authProxyRouter)` mounts every OAuth route: both discovery documents, `/authorize`, `/auth/callback`, and `/token`.
- `requireBearerAuth` runs before the `/mcp` handler and rejects any request without a valid `Authorization: Bearer` header, returning a `401` whose challenge points OAuth-aware clients at the discovery metadata.

Note that `index.js` implements no OAuth logic of its own — it mounts a router and a guard. That's what keeps the entry point thin as the flow gets more involved.

## Checkpoint

You should now have:

- [x] `UserAuthenticationProvider` in `aps.js`, with the data helpers unchanged
- [x] `proxy.js` exporting a factory with four routes and a token verifier
- [x] `mcp.js` unchanged apart from a tool description
- [x] `index.js` mounting the OAuth router and guarding `/mcp`

```text
.vscode/
  mcp.json
  launch.json
aps.js
mcp.js
proxy.js
index.js
package.json
```

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

    return server;
}
```

</details>

### Try it out

Start with the two discovery documents — they isolate the OAuth mechanics from anything Copilot-specific. Restart the server (`npm start`), then open each URL below in a browser tab, replacing `<PUBLIC_URL>` with your forwarded Codespace URL. Use the public URL, not `localhost`: it exercises the same address an MCP client will read these documents from.

1. `<PUBLIC_URL>/.well-known/oauth-authorization-server`

   You should see `authorization_endpoint`, `token_endpoint`, and `client_id_metadata_document_supported: true`. Check that the two endpoints are built on your public URL rather than `localhost` — a client outside the Codespace can only reach the public one.

2. `<PUBLIC_URL>/.well-known/oauth-protected-resource/mcp`

   Expect `resource` to be your `/mcp` URL and `authorization_servers` to list this server itself. Note the path: [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) puts the resource's own path *after* the well-known segment.

   If either tab shows a GitHub sign-in page instead of JSON, port 3000 is still private. Set its visibility to **Public** in the **Ports** panel.

3. Call `/mcp` without a token, from a second terminal:

   ```bash
   curl -i http://localhost:3000/mcp
   ```

   Expect a `401` with a `WWW-Authenticate: Bearer ... resource_metadata="..."` header rather than an MCP response.

Now the real thing:

4. In VS Code, restart the MCP server entry in `.vscode/mcp.json` and open a fresh Copilot Chat. Ask: *"What Forma projects do I have access to?"*
5. VS Code sees the `401`, discovers the sign-in flow, and opens a browser window on Autodesk's sign-in page. Sign in with your Autodesk account.
6. The browser lands on VS Code's own redirect page. Behind it, `proxy.js` completed the APS exchange and issued an authorization code, VS Code swapped it at `/token`, and the tool call completed — with the hubs and projects **your user** can see, which may differ from the application-level results from Part 2.

Common failure states:

- **`invalid_request` / "Unknown client_id or redirect_uri" instead of a redirect to Autodesk.** The `/authorize` guard rejected the request. The `client_id` must be an `https://` URL, and the `redirect_uri` must appear in the document that URL serves. Some MCP clients still use classic dynamic client registration, which this proxy doesn't support; VS Code and `npx @modelcontextprotocol/inspector` both support CIMD.
- **Autodesk rejects the login with a redirect URI mismatch.** `PUBLIC_URL` and the APS app's **Callback URL** disagree. Compare them character for character.
- **`Not authenticated` from a tool.** The server restarted, taking every session with it. Reconnect the MCP server in VS Code to sign in again.

### Additional resources

- [APS 3-legged OAuth tutorial](https://aps.autodesk.com/en/docs/oauth/v2/tutorials/get-3-legged-token/)
- [APS Authentication API reference](https://aps.autodesk.com/en/docs/oauth/v2/reference/http/)
- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [OAuth Client ID Metadata Documents (draft)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)
- [RFC 9728 — OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
