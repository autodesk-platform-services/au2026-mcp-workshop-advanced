# Extras

## Spec-Driven Development with GitHub Spec-Kit

The advanced server has three moving parts — HTTP transport, two OAuth flows, and the embedded viewer UI — and a change in one layer can quietly break the other two. Ad-hoc prompting with Copilot works well on a single file; at this scale it pays to slow down: write a specification first, plan the implementation, then let Copilot execute against an explicit checklist.

[GitHub Spec-Kit](https://github.com/github/spec-kit) is a small toolkit that does exactly that. It installs a set of slash commands into Copilot (and other agents) that walk you through a spec-driven workflow.

Some features worth tackling this way:

- **Issues tool.** Add a tool that lists open issues on a project using the [ACC Issues API](https://aps.autodesk.com/en/docs/acc/v1/overview/field-guide/issues/). Use the selection event from the viewer to filter issues by element.
- **Multi-model preview.** Extend `preview-design` to accept an array of designs and aggregate them in a single viewer scene with `loadDocumentNode` per model.
- **Persisted auth.** A server restart drops every `UserAuthenticationProvider` along with the proxy's in-memory session maps, so every client has to sign in again. Persist the refresh token (encrypted, e.g. Redis/SQLite) against a durable user identity, and rehydrate on startup so a restart doesn't sign everyone out.
- **Production-grade multi-user auth.** [Part 3](3-user-auth.md) gives each MCP token its own `UserAuthenticationProvider`, which is enough to stop two chats sharing one login — but it keys those sessions on the token it minted rather than a stable user identity, and the proxy itself is explicitly workshop-grade. See [Real per-user auth with Auth0](#real-per-user-auth-with-auth0) below for a production-oriented alternative built on a dedicated identity provider.
- **Smarter viewer context.** When the user selects an element, look it up via the Model Derivative properties API and feed a richer description back through `updateModelContext`.
- **Public deployment.** Put the server behind a stable hostname and update the APS app's Callback URL, so it survives longer than a Codespace. `npm install && npm start` is the whole image entrypoint.

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
- index.js stays thin: it only wires Express, the MCP handler, the OAuth
  proxy router, and the bearer-auth guard on /mcp. New features go in aps.js
  (APS calls), mcp.js (tool registration), or viewer.html (viewer UI).
- Refresh tokens never leave UserAuthenticationProvider, and no APS token is
  ever logged or persisted. Tools reach tokens only through getAccessToken().
  The one token that leaves the process is the short-lived access token in the
  preview-design payload, which the viewer needs to fetch derivatives.
- aps.js must not import from mcp.js. APS client code stays transport-agnostic
  so it can be reused outside MCP.
- PUBLIC_URL must match the APS app's Callback URL exactly, including scheme
  and port. Any new redirect-bearing flow goes through the same value.
- viewer.html never calls APS management APIs itself. It consumes the
  preview-design payload and the short-lived token that payload carries,
  and nothing else.
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
- No changes to index.js. No changes to viewer.html in this iteration.

Review checklist before /tasks:
- Token still comes from UserAuthenticationProvider, not a parameter.
- 403/404 from APS map to a user-readable MCP error, not a thrown Error.
- The selection lookup degrades gracefully when no model context exists.
```

`/tasks` then expands the plan into reviewable steps, and `/implement` executes them one at a time so you can catch regressions in HTTP transport or the auth flow before they compound.

## Real per-user auth with Auth0

[Part 3](3-user-auth.md)'s `proxy.js` answers "who is calling `/mcp`?" with the smallest thing that works: APS as the sole identity provider, no third-party tenant to set up, everything in memory. What it can't give you is a *stable* user identity — it keys each session on the token it minted, so the same person signing in twice ends up with two independent APS sessions, and all of them vanish on restart.

[**aps-mcp-auth0-example**](https://github.com/autodesk-platform-services/aps-mcp-auth0-example) is a reference implementation of the production-oriented alternative: the same APS MCP server shape, with [Auth0](https://auth0.com) as the authorization server in front of it.

### Architecture

The two OAuth flows stay independent end to end:

- **MCP client → MCP server.** Auth0 protects `/mcp`: every request needs a bearer token, which the server validates against Auth0's JWKS endpoint. The token's `sub` claim is a stable user ID that survives client reconnects.
- **MCP server → APS.** The same 3-legged flow you built in Part 3, except the provider is looked up (or created) per user ID from a `Map<userId, UserAuthenticationProvider>`. The Auth0 token is never forwarded to APS — the two flows never touch.

Client ID Metadata Documents work the same way as in Part 3, so MCP clients still discover the authorization server and identify themselves without you registering each one in the Auth0 tenant by hand.

### How its files map onto this project

| This project | `aps-mcp-auth0-example` | What changes |
|---|---|---|
| `index.js` | `app.js` | Wires the Auth0 bearer-token check and the metadata routes in front of the `/mcp` handler |
| `mcp.js` | `mcp.js` | Same stateless factory shape — `createMcpHandler` still builds one `McpServer` per request |
| `aps.js` (`UserAuthenticationProvider`) | `auth/aps.js` | Identical 3-legged logic, cached in a `Map<userId, UserAuthenticationProvider>` |
| `proxy.js` | `auth/auth0.js` | The hand-written authorization server is gone; Auth0 plays that role |
| *(new)* | `config.js` | Centralises the extra environment variables Auth0 needs |

### Setup, in brief

The repo's own README has the full walkthrough; the shape of it:

1. **Auth0 tenant.** Create an API with identifier `https://<PUBLIC_HOST>/mcp`, enable **Client ID Metadata Document Registration** and the **Resource Parameter Compatibility Profile** under Advanced Settings, then grant your client access to it.
2. **APS app.** Reuse the one from this workshop, adding `https://<PUBLIC_HOST>/auth/callback` as a callback URL if it isn't already registered.
3. **Environment variables.** `APS_CLIENT_ID`, `APS_CLIENT_SECRET`, `AUTH0_DOMAIN`, and `PUBLIC_HOST` (every derived URL and the Auth0 audience come from this one value).

> **This one can't run on `localhost`.** Auth0 needs a publicly reachable HTTPS audience and callback, so `PUBLIC_HOST` must be a real hostname — a forwarded Codespace port works, same as `PUBLIC_URL` does here.

## Production checklist

The advanced server is much closer to a real product than a STDIO prototype, but it still has rough edges. Address these before shipping:

| Area | Workshop state | Production requirement |
|---|---|---|
| Transport state | Stateless `createMcpHandler` + `toNodeHandler` wiring, no session map | Fine as-is for request/response tools; add a distributed `EventStore` only if you introduce resumable SSE streams or server-initiated push |
| APS identity | One `UserAuthenticationProvider` per MCP token minted by `proxy.js` — isolated per authorization, but with no stable user behind it | `Map<userId, UserAuthenticationProvider>`, keyed by the user ID the authorization server asserts on each request |
| Refresh tokens | Held in memory only | Encrypted persistence so users don't re-auth on restart |
| Multi-tenant safety | Per-token isolation, no durable user identity, no per-user limits | Per-user isolation via the identity map above, plus rate limiting, audit logs |
| Callback URL | A forwarded Codespace URL that changes with the Codespace | HTTPS-only URL on a stable hostname, registered in APS |
| Host/origin validation | `createMcpExpressApp({ host: '0.0.0.0' })`, no allowlist (required for Codespace port forwarding) | Pass `allowedHosts` / `allowedOrigins` (or bind to a fixed hostname) once you have a stable public domain |
| Viewer CSP | Permissive `connectDomains` | Tighten to only the endpoints the APS Viewer actually uses |
| Error handling | Errors logged to stderr | Structured logging, alerting, retry/backoff for APS calls |
| Viewer dependencies | The `ext-apps` `App` client is fetched from jsDelivr by the browser at runtime, pinned to an exact version | Self-host that file alongside the server, or pin it with Subresource Integrity via an import map, so the panel doesn't depend on a third party's availability |
| MCP client access | A CIMD-enabled OAuth proxy (`proxy.js`, Part 3) — four hand-written Express routes, deliberately stripped down: no PKCE check, no client authentication at `/token`, no rate limiting, no persistence, no rotation or revocation | Don't ship `proxy.js` as-is. Build a custom proxy with the missing checks and real persistence, or integrate a production identity provider — see [Real per-user auth with Auth0](#real-per-user-auth-with-auth0) above |

> **What's next?** With HTTP transport, 3-legged auth, and embedded UI in place, your server can host real product experiments. A natural follow-up is to add write operations (creating folders, uploading versions) — those need careful scoping and user-visible confirmations, but the building blocks are now all here.
