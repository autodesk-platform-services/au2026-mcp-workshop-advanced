# APS MCP Server (Advanced)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes Autodesk Forma project data over **Streamable HTTP**, acting on behalf of a signed-in Autodesk user. Built for the AU2026 advanced workshop, starting from the code the [beginner session](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner) produces.

## What it does

The server connects GitHub Copilot (or any MCP-compatible client) to the hubs and projects *the signed-in user* can see, and can render designs as interactive 3D previews directly in chat. Clients must sign in through the server's own OAuth endpoints before they can call a tool.

### MCP tools

| Tool | Inputs | Description |
| --- | --- | --- |
| `list-hubs-projects` | — | Lists all hubs and their projects accessible to the authenticated user |
| `list-folder-contents` | `hubId`, `projectId`, `folderId?` | Lists folder contents; omit `folderId` to get top-level folders |
| `preview-design` | `projectId`, `designId`, `region?` | Returns a payload the embedded APS Viewer UI uses to load the model |

### Viewer UI resource

`viewer.html` is registered as an MCP app resource under `ui://aps-mcp/viewer.html`. `preview-design` references it via `_meta.ui.resourceUri`, so a client that supports MCP Apps renders the viewer in a panel and feeds the tool's `structuredContent` to it. Selecting an object in 3D reports back to the host as extra model context.

There is no build step. `mcp.js` reads `viewer.html` from disk at module load, and the one browser-side library it needs is loaded from a CDN.

## Prerequisites

- Node.js 20+
- An APS application with `data:read` scope ([create one here](https://aps.autodesk.com/myapps)), with a **Callback URL** of `<PUBLIC_URL>/auth/callback`
- An Autodesk Forma hub your APS app is provisioned to, and membership of at least one project in it — the 3-legged flow uses *your* permissions

## Setup

```bash
npm install
npm start
```

| Variable | Required | Default |
| --- | --- | --- |
| `APS_CLIENT_ID` | yes | — |
| `APS_CLIENT_SECRET` | yes | — |
| `PORT` | no | `3000` |
| `PUBLIC_URL` | no | `http://localhost:<PORT>` |

`PUBLIC_URL` must match the **Callback URL** registered on the APS app, because the OAuth callback is served at `${PUBLIC_URL}/auth/callback`. In a Codespace, use the forwarded URL for port `3000` and set that port's visibility to **public** so the redirect can reach it.

## VS Code integration

`.vscode/mcp.json` registers the server as **APS MCP Server (Advanced)** over HTTP at `http://localhost:3000/mcp`. Start the server first, then register it from that file — Copilot connects over the network rather than launching the process itself.

Because `/mcp` is guarded by bearer auth, a spec-compliant client discovers the sign-in flow from the `401` challenge and opens a browser prompt on its own. `.vscode/launch.json` runs the same entry point under the Node debugger, with `PUBLIC_URL` derived from the Codespace's forwarded hostname; delete its `env` block when running locally.

## Architecture

```text
index.js          Entry point — Express app, MCP handler, OAuth proxy router, bearer guard on /mcp
mcp.js            MCP server factory — registers tools + the viewer resource, never calls server.connect()
aps.js            APS layer — 3-legged OAuth provider + Data Management helpers
proxy.js          OAuth authorization server in front of /mcp (demo-only, see below)
viewer.html       Self-contained APS Viewer panel, served as an MCP app resource
```

`UserAuthenticationProvider` (in `aps.js`) holds a user's access and refresh tokens and exposes a single `getAccessToken()` method — the same interface a 2-legged provider exposes, which is why the Data Management helpers work unchanged under either. Raw APS tokens never leave the class.

APS identity is resolved **per token**: `proxy.js` mints a `UserAuthenticationProvider` per authorization and attaches a bound `getAccessToken()` to each request's `authInfo`, so two clients never share a login.

> **`proxy.js` is a workshop stand-in, not production-ready.** It has no PKCE verification, no client authentication at `/token`, no rate limiting, no revocation, and no persistence — all state is in memory and resets on restart. It exists so the whole two-layer OAuth flow is readable in one file. Replace it with a purpose-built implementation or a dedicated identity provider before shipping.

## Tutorial

Step-by-step instructions for building this server from scratch are in the `docs/` folder. Serve them locally with:

```bash
npx serve docs -l 4000
```

Then open `http://localhost:4000` — port `3000` is left free for the MCP server itself.
