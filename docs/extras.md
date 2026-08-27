# Extras

## Spec-Driven Development with GitHub Spec-Kit

The advanced server has three moving parts — HTTP transport, 3-legged OAuth, and the embedded viewer UI — and a change in one layer can quietly break the other two. The beginner workshop walked you through ad-hoc "vibe coding" with Copilot. For features at this scale it pays to slow down: write a specification first, plan the implementation, then let Copilot execute against an explicit checklist.

[GitHub Spec-Kit](https://github.com/github/spec-kit) is a small toolkit that does exactly that. It installs a set of slash commands into Copilot (and other agents) that walk you through a spec-driven workflow.

Some features worth tackling this way:

- **Issues tool.** Add a tool that lists open issues on a project using the [ACC Issues API](https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/issues/). Use the selection event from the viewer to filter issues by element.
- **Multi-model preview.** Extend `preview-design` to accept an array of designs and aggregate them in a single viewer scene with `loadDocumentNode` per model.
- **Persisted auth.** A server restart clears the shared `UserAuthenticationProvider`'s tokens and forces a fresh login for everyone. Persist the refresh token (encrypted, e.g. Redis/SQLite) and rehydrate it on startup so a restart doesn't log the server out.
- **Production-grade multi-user auth.** [Part 5](5-client-auth.md) already gets you real multi-user auth by keying `UserAuthenticationProvider` instances off the OAuth proxy's own MCP tokens — but that proxy is explicitly workshop-grade. See [Real per-user auth with Auth0](#real-per-user-auth-with-auth0-layer-1) below for a production-oriented alternative built on a dedicated identity provider.
- **Smarter viewer context.** When the user selects an element, look it up via the Model Derivative properties API and feed a richer description back through `updateModelContext`.
- **Public deployment.** Put the server behind a stable hostname and update the APS app's Callback URL. There's no build step to containerise — `npm install && npm start` is the whole image entrypoint.

### Suggested workflow

1. Install Spec-Kit into your repo. From the project root in your Codespace, run:

   ```bash
   uvx --from git+https://github.com/github/spec-kit.git specify init --here --ai copilot
   ```

   This drops a `.specify/` folder and a set of slash commands into your Copilot configuration. Swap `copilot` for `claude`, `gemini`, etc., if you prefer a different agent.

2. **`/constitution`** — capture the invariants this server already enforces (thin `index.js`, tokens never leave `UserAuthenticationProvider`, `aps.js` doesn't import from `mcp.js`, `PUBLIC_URL` matches the APS Callback URL). Copilot will reference these on every later step.
3. **`/specify`** — describe the feature in plain language. Focus on *what* and *why*, not *how*. Example: "List open issues on a project, filterable by the element currently selected in the viewer."
4. **`/plan`** — let Copilot draft a technical plan: which files change, which APS endpoint it calls, how the result is surfaced through MCP and the viewer UI. Review the plan carefully — HTTP servers and OAuth flows are easier to break than they look.
5. **`/tasks`** — break the plan into discrete, reviewable steps.
6. **`/implement`** — Copilot works through the task list. Test end-to-end via Copilot Chat *and* `npx @modelcontextprotocol/inspector http://localhost:3000/mcp` to isolate transport vs. tool issues.

> **Why spec-first here?** The advanced server crosses three trust boundaries (the MCP client, your Express app, and APS). A short written spec catches scope creep and missing authorisation checks before they land in `index.js` — the file that should stay thin.

### Example: an issues tool, spec-first

Below is the kind of input each slash command expects. Don't copy these verbatim — they're a shape to imitate when you write your own.

**`/constitution`** — invariants this codebase already enforces:

```text
- index.js stays thin: it only wires Express, the MCP handler, and the auth
  provider. New features go in aps.js (APS calls), mcp.js (tool registration),
  or web/ (viewer UI).
- Access tokens never leave UserAuthenticationProvider. Tools receive a
  token via the provider, never via globals or request bodies.
- aps.js must not import from mcp.js. APS client code stays transport-agnostic
  so it can be reused outside MCP.
- PUBLIC_URL must match the APS app's Callback URL exactly, including scheme
  and port. Any new redirect-bearing flow goes through the same value.
- The viewer (web/) only talks to the server over the existing MCP session;
  it never holds an APS access token directly.
```

**`/specify`** — feature description (the *what* and *why*, not the *how*):

```text
Add a tool that lists open issues on an ACC project so the user can triage
them from Copilot Chat without leaving the viewer.

User stories:
- As a project admin, I can ask "what issues are open on project X?" and get
  a list of titles, statuses, and assignees.
- As a reviewer with an element selected in the embedded viewer, I can ask
  "any issues on this?" and get only issues linked to that element.

Out of scope: creating, updating, or closing issues; comments; attachments.

Success criteria:
- Returns at most 50 issues, newest first.
- Filters by the viewer's current selection when one is present in the
  session context.
- Surfaces a clear error (not a stack trace) when the user lacks access to
  the project.
```

**`/plan`** — what Copilot should draft, and what to look for when you review it:

```text
Expected touch points:
- aps.js: new listOpenIssues(projectId, { elementUrn? }) wrapping
  GET /construction/issues/v1/projects/{projectId}/issues. Pagination handled
  internally; returns at most 50.
- mcp.js: register `list-issues` tool taking { projectId, useSelection? }.
  When useSelection is true, read the current selection from the session's
  model context (set by updateModelContext) and pass it as elementUrn.
- No changes to index.js. No changes to web/ in this iteration.

Review checklist before /tasks:
- Token still comes from UserAuthenticationProvider, not a parameter.
- 403/404 from APS map to a user-readable MCP error, not a thrown Error.
- The selection lookup degrades gracefully when no model context exists.
```

`/tasks` then expands the plan into reviewable steps, and `/implement` executes them one at a time so you can catch regressions in HTTP transport or the auth flow before they compound.

## Real per-user auth with Auth0 (Layer 1)

Part 3 leaves one question deliberately unanswered: *which human is behind this HTTP request?* Its `UserAuthenticationProvider` is shared by the whole process because there's no stable, per-request identity to key anything else on — see the [design note](3-user-auth.md#one-shared-provider-for-now). [**aps-mcp-auth0-example**](https://github.com/autodesk-platform-services/aps-mcp-auth0-example) is a reference implementation that answers that question: it adds the Layer 1 handshake this workshop skips, using [Auth0](https://auth0.com) as the authorization server, on top of the same APS MCP server shape you've just built.

[Part 5](5-client-auth.md)'s `proxy.js` answers the same question a different way — APS itself as the sole identity provider, no third-party tenant to set up — at the cost of being explicitly workshop-grade rather than production-ready (see its Theory section). The two approaches solve the same Layer 1 problem; which one fits a real deployment depends on whether you already run a dedicated identity provider.

### Architecture

The two OAuth layers stay independent end to end:

- **Layer 1 (MCP client ↔ MCP server).** Auth0 protects `/mcp` directly: every request needs an `Authorization: Bearer` token, which the server validates against Auth0's JWKS endpoint. The token's `sub` claim becomes the `userId` — a stable identity that survives client reconnects, unlike an MCP session ID.
- **Layer 2 (MCP server ↔ APS).** The same 3-legged flow you built in Part 3, unchanged, except the provider is now looked up (or created) per `userId` from a `Map<userId, UserAuthenticationProvider>` instead of shared process-wide. The Auth0 token is never forwarded to APS — the two flows never touch.

The example also implements [Client ID Metadata Documents (CIMD)](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-client-id-metadata-document-00) via a `/.well-known/oauth-protected-resource/mcp` endpoint, so MCP clients can discover Auth0 as the authorization server and authenticate without you manually registering each client in the Auth0 tenant — the same gap flagged as out of scope in [Part 3](3-user-auth.md#one-shared-provider-for-now).

### How its files map onto this project

| This project | `aps-mcp-auth0-example` | What changes |
|---|---|---|
| `index.js` | `app.js` | Wires the Layer 1 bearer-token check and CIMD metadata routes in front of the existing `/mcp` handler |
| `mcp.js` | `mcp.js` | Same stateless factory shape — `createMcpHandler` still builds one `McpServer` per request |
| `aps.js` (`UserAuthenticationProvider`) | `auth/aps.js` | Identical 3-legged logic, now cached in a `Map<userId, UserAuthenticationProvider>` instead of one shared instance |
| *(new)* | `auth/auth0.js` | JWKS-based token verification and Auth0 metadata discovery |
| *(new)* | `config.js` | Centralises the extra environment variables Layer 1 needs |

### Setup, in brief

The repo's own README has the full walkthrough; the shape of it:

1. **Auth0 tenant.** Create an API with identifier `https://<PUBLIC_HOST>/mcp`, enable **Client ID Metadata Document Registration** and the **Resource Parameter Compatibility Profile** under Advanced Settings, then grant your client access to it.
2. **APS app.** Reuse the one from this workshop — just add `https://<PUBLIC_HOST>/auth/callback` as a callback URL if it isn't already registered.
3. **Environment variables.** `APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `AUTH0_DOMAIN`, and `PUBLIC_HOST` (every derived URL and the Auth0 audience come from this one value).

> **This one can't run on `localhost`.** Auth0 needs a publicly reachable HTTPS audience and callback, so `PUBLIC_HOST` must be a real hostname — a forwarded Codespace port works, same as `PUBLIC_URL` did in Part 3.

## Production checklist

The advanced server is much closer to a real product than the beginner's STDIO build, but it still has rough edges. Address these before shipping:

| Area | Workshop state | Production requirement |
|---|---|---|
| Transport state | Stateless `createMcpHandler` + `toNodeHandler` wiring, no session map | Fine as-is for request/response tools; add a distributed `EventStore` only if you introduce resumable SSE streams or server-initiated push |
| APS identity | One shared `UserAuthenticationProvider` for the whole process | `Map<userId, UserAuthenticationProvider>`, keyed by the user ID a Layer 1 authorization server puts on each request |
| Refresh tokens | Held in memory only | Encrypted persistence so users don't re-auth on restart |
| Multi-tenant safety | One process trust boundary, one shared APS identity | Per-user isolation via the identity map above, plus rate limiting, audit logs |
| Callback URL | `http://localhost:3000/auth/callback` | HTTPS-only public URL registered in APS |
| Host/origin validation | `createMcpExpressApp({ host: '0.0.0.0' })`, no allowlist (required for Codespace port forwarding) | Pass `allowedHosts` / `allowedOrigins` (or bind to a fixed hostname) once you have a stable public domain |
| Viewer CSP | Permissive `connectDomains` | Tighten to only the endpoints the APS Viewer actually uses |
| Error handling | Errors logged to stderr | Structured logging, alerting, retry/backoff for APS calls |
| Viewer dependencies | The `ext-apps` `App` client is fetched from jsDelivr by the browser at runtime, pinned to an exact version | Self-host that file alongside the server, or pin it with Subresource Integrity via an import map, so the panel doesn't depend on a third party's availability |
| MCP client access | A CIMD-enabled OAuth proxy (`proxy.js`, Part 5) — four hand-written Express routes, deliberately stripped down: no PKCE check, no client authentication at `/token`, no rate limiting, no persistence, no rotation or revocation | Don't ship `proxy.js` as-is. Build a custom proxy with the missing checks and real persistence, or integrate a production identity provider — see [Real per-user auth with Auth0](#real-per-user-auth-with-auth0-layer-1) above |

> **What's next?** With HTTP transport, 3-legged auth, and embedded UI in place, your server can host real product experiments. A natural follow-up is to add write operations (creating folders, uploading versions) — those need careful scoping and user-visible confirmations, but the building blocks are now all here.
