# APS MCP Server (Advanced)

An [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server that exposes Autodesk Forma project data via the [APS Data Management API](https://aps.autodesk.com/en/docs/data/v2/reference/http/), with per-user authentication and an embedded 3D viewer. Built for the AU2026 advanced workshop — it evolves the [beginner session's](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner) server into a multi-user HTTP service.

## What it does

The server connects GitHub Copilot (or any MCP-compatible client) to your APS hubs and projects over HTTP, letting an AI assistant browse folder structures, act on behalf of the signed-in Autodesk user, and render interactive 3D previews of designs directly in the chat.

### MCP tools

| Tool | Inputs | Description |
| --- | --- | --- |
| `list-hubs-projects` | — | Lists all hubs and their projects accessible to the signed-in user |
| `list-folder-contents` | `hub_id`, `project_id`, `folder_id?` | Lists folder contents; omit `folder_id` to get top-level folders |
| `preview-design` | `project_id`, `design_id`, `region?` | Renders an interactive 3D preview of a design in the embedded APS Viewer |

Every tool call from a session that hasn't completed sign-in returns a login URL instead of data — see **Authentication** below.

## Prerequisites

- Python 3.10+
- Node.js 20+ (only needed to build the embedded viewer UI — see **Setup**)
- An APS application with `data:read` scope and a **Callback URL** configured ([create one here](https://aps.autodesk.com/myapps))
- Admin access to an Autodesk Forma hub, and membership in at least one project in that hub

## Setup

Install the Python server dependencies:

```bash
pip install -r requirements.txt
```

Build the embedded viewer UI (a static HTML bundle the server reads — Node.js is not needed at runtime, only for this build step):

```bash
npm install
npm run build
```

Start the server:

```bash
python main.py
```

By default it listens on port `3000`. Set `PORT` to change it, and `PUBLIC_URL` if the server is reachable at a different origin than `http://localhost:<PORT>` (for example, a forwarded Codespace port) — `PUBLIC_URL` must match the APS app's Callback URL exactly.

## Authentication

Unlike the beginner session's 2-legged (app-level) authentication, this server uses 3-legged OAuth: each MCP session gets its own `UserAuthenticationProvider` and acts as the signed-in Autodesk user, not the application. The first tool call in a new session returns an authorization URL; open it in a browser, sign in, and the server completes the exchange at `/auth/callback`. Access and refresh tokens are held in memory per session and never leave `UserAuthenticationProvider` — restarting the server signs everyone out.

## VS Code integration

`.vscode/mcp.json` registers the server as **APS MCP Server (Advanced)** using the Streamable HTTP transport at `http://localhost:3000/mcp/`. Unlike the beginner session, VS Code doesn't launch the server for you — start it yourself with `python main.py` first, then open Copilot Chat in agent mode.

## Architecture

```text
main.py           Entry point — Starlette + uvicorn app, per-session Streamable HTTP transport, /auth/callback
server.py         MCP server factory — registers tools and the viewer UI resource, never starts a transport
aps.py            APS layer — 3-legged OAuth provider + Data Management helpers
ui/               Viewer UI source (APS Viewer + @modelcontextprotocol/ext-apps client)
vite.config.js    Bundles ui/ into dist/viewer.html (read directly by server.py)
```

`UserAuthenticationProvider` (in `aps.py`) caches access and refresh tokens in memory and exposes the same `get_access_token()` method the beginner session's `AppAuthenticationProvider` does — the Data Management helpers (`get_hubs_projects`, `get_folder_contents`) are unchanged from the beginner session and call it internally without knowing which provider they're talking to.

## Tutorial

Step-by-step instructions for building this server from scratch are in the `docs/` folder. Serve them locally with:

```bash
npx serve docs
```

Then open `http://localhost:3000`.
