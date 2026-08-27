# Part 5: Client Authentication

In this section you'll add `proxy.js`, a small OAuth Authorization Server that sits in front of `/mcp` — so an MCP client has to sign in with a real Autodesk account before it can call a single tool, instead of the open endpoint you've had since Part 2.

## Theory

### Two layers of OAuth

Part 3's design note named the gap this part closes: MCP defines a **Layer 1** handshake between the MCP client and the MCP server, separate from **Layer 2** — whatever the server does on the user's behalf, which is the 3-legged APS flow you already built. Until now, this workshop has only implemented Layer 2. `/mcp` itself has never checked who — or what — is calling it.

Closing Layer 1 also finishes something Part 3 deliberately left unfinished: real multi-user support. Once every request carries a validated MCP token, `Map<userId, UserAuthenticationProvider>` (the shape Part 3's design note already described) stops being a hypothetical — this part builds exactly that map, keyed by the MCP token this proxy mints.

### Why you write the OAuth endpoints yourself

MCP OAuth has two halves. The **Resource Server** half — validating a bearer token on every `/mcp` request, and telling unauthenticated clients where to go instead — ships in the v2 SDK: `requireBearerAuth` and `mcpAuthMetadataRouter` between them do all of it. The **Authorization Server** half — the `/authorize` and `/token` endpoints that actually run a login and hand out tokens — doesn't ship at all. That's deliberate. Most MCP servers are expected to *point at* an identity provider, not *be* one.

This workshop can't take that shortcut, because the thing you're signing into is APS, and APS knows nothing about MCP clients. So `proxy.js` becomes the Authorization Server. That's a heavier sentence than it is a file — it's four routes, one per step of the flow:

| Route | Who calls it | What it does |
| --- | --- | --- |
| the two `.well-known` documents | the MCP client, on a `401` | advertises the endpoints below — `mcpAuthMetadataRouter` serves these for you |
| `/authorize` | the MCP client's browser | identifies the client, then redirects to APS's real sign-in page |
| `/auth/callback` | APS, after the user signs in | completes the APS exchange, hands the client a one-time code |
| `/token` | the MCP client | swaps that code for tokens *this* server minted |

Writing them by hand is also the point, pedagogically: every value that crosses a trust boundary in this flow is visible in a single file you can read top to bottom.

### One SDK, not two

Every server-side import in this session comes from the **v2** packages — `@modelcontextprotocol/server`, `@modelcontextprotocol/express`, `@modelcontextprotocol/node` — and `proxy.js` is no exception. The older `@modelcontextprotocol/sdk` (v1) is a **dev dependency**, needed only so Vite can bundle the viewer you built in Part 4. Nothing you run on the server touches it.

That's worth a moment, because v1 *does* ship an Authorization Server toolkit — `mcpAuthRouter`, built around an `OAuthServerProvider` interface — which would replace maybe fifteen lines of what you're about to write. The cost is holding two SDK generations in your head at once: v1 provider objects on one side of the file, v2 `OAuthError` and `AuthInfo` on the other, with separate and non-interchangeable error classes between them. For fifteen lines of plain Express, that trade isn't worth making.

### CIMD instead of manual registration

A traditional OAuth Authorization Server requires clients to register up front, or asks you to hand out a `client_id` manually. [Client ID Metadata Documents (CIMD)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00) skip that: an MCP client's `client_id` is simply an HTTPS URL it controls, pointing at a small JSON document describing itself (its `redirect_uris`, and so on). The Authorization Server fetches that URL the first time it sees it and treats the result as the client's registration.

### This is a workshop stand-in, not production-ready

> **Design note: this is a workshop simplification, not a template for production.** This proxy trades away most of what a real Authorization Server would do: no persistence, no PKCE verification, no client authentication at `/token`, no rate limiting on either endpoint, no token revocation, no rotation on refresh. Everything lives in memory and resets on restart, same as `UserAuthenticationProvider`'s own cache — that's an intentional trade of robustness for a small, readable file. Don't ship this as-is. A real deployment should either build a purpose-fit proxy with the missing checks, or — more commonly — integrate a dedicated identity provider (Auth0, Okta, Entra ID, …) instead of proxying through your own APS app. [Extras](extras.md) has a full reference implementation using Auth0.

## Step 1: Resolve MCP clients via CIMD

Create `proxy.js` at the project root. Start with a one-line disclaimer, the imports, the module constants, and a resolver that turns a CIMD `client_id` URL into that client's registration:

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
```

That first line is the only comment in the finished file — everything else is explained here in the tutorial rather than inline, so the code itself stays short enough to read in one sitting. Keep the disclaimer, though: this file is the one an attendee is most likely to copy into something real.

`resolveClient` rejects any `client_id` that isn't an `https://` URL outright — this proxy only supports CIMD, not classic Dynamic Client Registration. Otherwise the document is fetched once and cached, and `undefined` means "unknown client" to the `/authorize` route in Step 5.

## Step 2: Validate the redirect URI

The single most important check in the whole file. Add it below `resolveClient`:

```js
function isRegisteredRedirectUri(requested, client) {
    return typeof requested === 'string' && (client.redirect_uris ?? []).includes(requested);
}
```

`/authorize` takes a `redirect_uri` from the query string and eventually sends an authorization code there. Without this check, anyone could pass `?redirect_uri=https://attacker.example` and have your server deliver a valid code to them — an open redirector, and a full account takeover. So a requested URI has to appear in the CIMD document's `redirect_uris`, which only the real client controls.

The comparison is exact, character for character — the simple string comparison [RFC 6749 §3.1.2](https://datatracker.ietf.org/doc/html/rfc6749#section-3.1.2) asks for. That is enough for the client you'll test with. VS Code publishes a fixed pair of redirect URIs in [its CIMD document](https://vscode.dev/oauth/client-metadata.json) — `https://vscode.dev/redirect` for the web build you're running in the Codespace, `http://127.0.0.1:33418/` for the desktop build — and sends the matching one verbatim. Nothing needs normalising, so nothing here does.

A client that binds an OS-assigned loopback port instead can't publish an exact URI ahead of time, and would need the port-only relaxation [RFC 8252 §7.3](https://datatracker.ietf.org/doc/html/rfc8252#section-7.3) allows. VS Code pins its port, so this proxy doesn't carry that code.

> **Design note: this is the check to keep.** Almost everything else in this file is simplified for the workshop. This isn't. If you strip `proxy.js` down further for your own experiments, strip somewhere else.

## Step 3: Open the factory and declare its state

Everything else in this file lives inside one exported factory. Add its opening, the four maps that hold all of this proxy's state, and the helper that mints a token pair:

```js
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
```

Because the whole file is one factory closing over these `const`s, nothing needs a class, a constructor, or `this` — the config parameters and the four maps are simply in scope for every function below.

That's the proxy's entire state, all of it in memory and none of it surviving a restart. What each map holds:

| Map | Key | Value |
| --- | --- | --- |
| `pendingAuthorizations` | correlation id | `{ clientId, redirectUri, state, apsProvider }` — a login in flight at APS |
| `issuedCodes` | MCP authorization code | `{ clientId, apsProvider }` — redeemable once, at `/token` |
| `sessions` | MCP access token | `{ clientId, apsProvider, expiresAt }` |
| `refreshTokens` | MCP refresh token | `{ clientId, apsProvider }` |

None of this state is APS tokens. Those stay inside each `UserAuthenticationProvider` instance, exactly as `aps.js` already guarantees; the maps only hold values this proxy minted itself.

> **Design note: four maps, on purpose.** Every one of these maps ultimately points at the same thing — a `UserAuthenticationProvider` — so it's tempting to merge them. Don't. Keeping them separate is what makes a refresh token useless as an access token, and a login code useless as either. Collapsing credential namespaces to save a line is a real vulnerability class, and it's the exact mistake this whole part exists to teach you to avoid.

## Step 4: Advertise the discovery metadata

Create the router, and let the SDK serve both `.well-known` documents:

```js
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
```

This is the one piece of Authorization Server machinery the v2 SDK does give you. `mcpAuthMetadataRouter` mounts two routes: `/.well-known/oauth-protected-resource/mcp`, which it derives from `resourceServerUrl`, and `/.well-known/oauth-authorization-server`, which it serves from your `oauthMetadata` object **verbatim**. That pass-through is why `client_id_metadata_document_supported: true` can simply sit in the object literal — it's a draft field no SDK builder knows about, and without it, conformant clients would never learn this server accepts CIMD client IDs.

The `express.urlencoded` line matters too, and is easy to miss: `index.js` builds its app with `createMcpExpressApp`, which installs a JSON body parser only. OAuth token requests are `application/x-www-form-urlencoded`, so without this, `req.body` at `/token` would be empty.

> **Design note: honest metadata.** Every field here is a claim clients will act on. `grant_types_supported` lists exactly the two grants Step 7 implements, and there's no `registration_endpoint`, because this proxy genuinely doesn't do Dynamic Client Registration. Advertising a capability you haven't built produces failures that look like client bugs.

## Step 5: Forward the authorization request

The first real endpoint. A client arrives here to start a login:

```js
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
```

Both checks from Steps 1 and 2 run first, and nothing else happens until they pass. Then, instead of redirecting back to the MCP client, this route creates a *fresh* `UserAuthenticationProvider` — the same class Part 3 built, unchanged — stashes everything needed to resume under a random correlation id, and sends the browser to APS's real sign-in page, reusing the callback URL Part 3 already registered with your APS app.

The `state` juggling is the subtle part. There are two of them. The client's own `state` goes into `pendingAuthorizations` untouched, to be handed back in Step 6 — that's how the client detects a forged callback. The `state` this route puts on the *APS* URL is our own `correlationId`, which is how the next step finds its way back to this pending login. Conflating the two would leak the client's `state` to APS and lose our own handle.

## Step 6: Finish the login and issue a code

APS sends the user back here:

```js
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
```

This is the hinge between the two OAuth layers. It looks the pending login up by correlation id, calls `exchangeAuthCode` (Part 3's method, untouched) to complete the *APS* exchange, then mints an authorization code of *its own* and redirects the browser to the MCP client's `redirect_uri` with it — plus the client's original `state`.

Note what does **not** travel outward: APS's code was consumed here, and the APS tokens it bought stay inside `apsProvider`. The MCP client receives `mcpCode`, a value that means nothing to APS. This is the same boundary `aps.js` enforces inside one process, now holding across a redirect.

This is also the one route with a `try/catch`, because it's the one route where a failure is a person staring at a browser rather than a client parsing JSON.

## Step 7: Mint MCP tokens

The last endpoint. The client comes here with the code from Step 6, and again later to refresh:

```js
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
```

Both grants converge on the same two lines, because both mean the same thing: prove you hold a value this server issued, and get a fresh token pair bound to the same APS session. Neither one talks to APS. The APS-side refresh cycle lives entirely inside `UserAuthenticationProvider.getAccessToken()` and runs lazily, the next time a tool actually needs an APS token.

Two details carry real weight:

- **The `if (!grant)` guard.** Without it, an unrecognised `code` would sail through as `undefined` and still mint a working access token — the failure would only surface much later, deep inside a tool call, as a confusing `undefined` error. An unknown grant has to fail here, loudly, as `invalid_grant`.
- **`issuedCodes.delete(code)`.** An authorization code is single-use by definition. Deleting it on first redemption is what makes a replayed code fail the guard above.

Notice also where `clientId` comes from: the stored grant, not the request. A client can't claim someone else's session by sending a different `client_id`.

## Step 8: Return the token verifier

Close the factory with the two things `index.js` needs:

```js
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

`tokenVerifier` matches the `{ verifyAccessToken }` shape `requireBearerAuth` expects, and throws `OAuthError`, which the middleware turns into a `401` with a `WWW-Authenticate` challenge. It must return `expiresAt`: the bearer-auth middleware rejects any token whose expiry is unset.

`extra` is the hand-off to `mcp.js`. `verifyAccessToken` has already found the session, so rather than making `mcp.js` come back with the token for a second lookup, it attaches what the tool handlers actually need. Note what goes in there: a closure over `getAccessToken`, *not* the `UserAuthenticationProvider` itself. That object's token cache is a public field, so putting the instance on `authInfo` would leave raw APS tokens one property access away from anything holding the request context. A bound function exposes nothing.

## Step 9: Simplify `mcp.js`

`requireBearerAuth` (wired up next) now rejects any request without a valid MCP token before `createMcpServer` ever runs — so the `withAuth` wrapper and its "please log in at…" fallback from Part 3 are no longer needed. Replace the factory's opening and drop the wrapper from all three tools:

```js
export function createMcpServer(authInfo, publicUrl) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        description: 'MCP server for Autodesk Platform Services',
        version: '1.0.0'
    });

    // By the time this factory runs, `requireBearerAuth` (see index.js) has already
    // rejected any request without a valid MCP token, so every tool handler below can
    // assume it's authenticated. The proxy attaches this request's APS session to
    // `authInfo.extra` as a bound `getAccessToken()` — the same interface
    // `UserAuthenticationProvider` exposes, so the data helpers imported above don't
    // need to know or care that the token now comes from the OAuth proxy.
    const authenticationProvider = authInfo.extra.apsAuthenticationProvider;
```

The factory used to take a single, process-wide `authenticationProvider`. It still takes exactly two arguments, but the first is now the current request's validated `authInfo`, and the provider comes off its `extra` field — the one `proxy.js` populated in Step 8. Since that provider already satisfies the `getAccessToken()` interface, every tool body below this line — `getHubsProjects(authenticationProvider)`, `getFolderContents(...)`, `getItemTip(...)`, and the direct call in `preview-design` — stays completely unchanged. Just remove the `withAuth(...)` call wrapping each handler, so `list-hubs-projects` goes back to:

```js
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
```

Do the same for `list-folder-contents` and `preview-design` — un-wrap the handler, nothing inside it changes.

## Step 10: Update the entry point

Swap the shared `UserAuthenticationProvider` for the new proxy, and gate `/mcp` behind it:

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
const mcpHandler = createMcpHandler((ctx) => createMcpServer(ctx.authInfo, PUBLIC_URL));

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

The diff from Part 4:

- `UserAuthenticationProvider` and the old `/auth/callback` route are both gone from `index.js` — `createOAuthProxy` owns them now.
- `createMcpHandler`'s factory changes from `() => createMcpServer(authProvider, PUBLIC_URL)` to `(ctx) => createMcpServer(ctx.authInfo, PUBLIC_URL)`. The v2 SDK calls this factory once per request and passes it `ctx.authInfo` — the same `AuthInfo` `requireBearerAuth` attached to the request, `extra` field and all — for exactly this kind of multi-tenant use.
- `app.use(authProxyRouter)` mounts every OAuth route `proxy.js` builds: both `.well-known` metadata endpoints, `/authorize`, `/auth/callback`, and `/token`.
- `app.use('/mcp', requireBearerAuth({ ... }))` is new. It runs before the existing `app.all('/mcp', ...)` handler and rejects any request without a valid `Authorization: Bearer` header, returning a `401` with a `WWW-Authenticate` challenge that points OAuth-aware clients at the discovery metadata.

## Checkpoint

You should now have:

- [x] `proxy.js` exporting `createOAuthProxy`, with four routes: the two `.well-known` documents, `/authorize`, `/auth/callback`, and `/token`
- [x] `mcp.js` taking its `authenticationProvider` from `authInfo.extra`, with `withAuth` removed
- [x] `index.js` mounting `proxy.js`'s router and protecting `/mcp` with `requireBearerAuth`
- [x] `express` added as a direct dependency (`proxy.js` builds its own `express.Router()`)
- [x] no server-side file importing `@modelcontextprotocol/sdk` — every import comes from the v2 packages

<details>
    <summary>
        Reference: full <code>proxy.js</code>
    </summary>

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

</details>

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

export function createMcpServer(authInfo, publicUrl) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        description: 'MCP server for Autodesk Platform Services',
        version: '1.0.0'
    });

    // By the time this factory runs, `requireBearerAuth` (see index.js) has already
    // rejected any request without a valid MCP token, so every tool handler below can
    // assume it's authenticated. The proxy attaches this request's APS session to
    // `authInfo.extra` as a bound `getAccessToken()` — the same interface
    // `UserAuthenticationProvider` exposes, so the data helpers imported above don't
    // need to know or care that the token now comes from the OAuth proxy.
    const authenticationProvider = authInfo.extra.apsAuthenticationProvider;

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
const mcpHandler = createMcpHandler((ctx) => createMcpServer(ctx.authInfo, PUBLIC_URL));

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

Start with a plain HTTP walkthrough — it isolates the OAuth mechanics from anything Copilot-specific.

1. Rebuild and restart: `npm run build && npm start`.
2. Check the metadata this server now advertises:

   ```bash
   curl -s http://localhost:3000/.well-known/oauth-authorization-server | jq
   ```

   You should see `authorization_endpoint`, `token_endpoint`, and `client_id_metadata_document_supported: true` — and no `registration_endpoint`, since this proxy only supports CIMD.

3. Check the other document `mcpAuthMetadataRouter` serves — the one that tells a client which Authorization Server guards `/mcp`:

   ```bash
   curl -s http://localhost:3000/.well-known/oauth-protected-resource/mcp | jq
   ```

   Expect `resource` to be your `/mcp` URL and `authorization_servers` to list this server itself. Note the path: RFC 9728 puts the resource's own path *after* the well-known segment.

4. Call `/mcp` without a token and confirm it's rejected:

   ```bash
   curl -i http://localhost:3000/mcp
   ```

   Expect a `401` with a `WWW-Authenticate: Bearer ...resource_metadata="..."` header, not a normal MCP response.

5. In VS Code, reconnect the MCP server (or start a fresh Copilot Chat) and ask the same question you did in Part 3: *"What Forma projects do I have access to?"* This time, VS Code detects the `401` challenge itself, discovers this server's Authorization Server metadata, and opens a browser window straight to the APS sign-in page — no login URL pasted into the chat.
6. Sign in, land on the same *"Login successful!"* page from Part 3, and watch the tool call complete with your projects.
7. Open a second, fresh Copilot Chat. Unlike Part 3, this one does **not** automatically see your login — each MCP client authorization is now independent, keyed by its own MCP token rather than one shared process-wide provider.

> **CIMD in practice.** Whether you see the CIMD path exercised depends on how your MCP client identifies itself — some clients still use classic Dynamic Client Registration, which this proxy doesn't support (only CIMD). If sign-in fails with `invalid_request` and *"Unknown client_id or redirect_uri"* instead of redirecting to APS, that's Step 5's guard rejecting the request: check the `client_id` your client sent (it must be an `https://` URL) and confirm the `redirect_uri` it sent appears in the document that URL serves. VS Code's MCP client and `npx @modelcontextprotocol/inspector` both support CIMD.

### Additional resources

- [MCP Authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
- [OAuth Client ID Metadata Documents (draft)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00)
- [RFC 6749 §3.1.2 — Redirection endpoint](https://datatracker.ietf.org/doc/html/rfc6749#section-3.1.2)
- [RFC 9728 — OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
