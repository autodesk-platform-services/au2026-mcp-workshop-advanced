# AU2026 MCP Workshop: Advanced

Welcome to the advanced session of the **Autodesk Platform Services MCP Workshop** at Autodesk University 2026.

## What you'll build

You'll evolve the MCP server from the [beginner workshop](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner) so it can call Autodesk Platform Services **on behalf of a signed-in user**, with 3-legged OAuth and an embedded 3D viewer:

- Replace the local **STDIO** transport with **Streamable HTTP** over Express, using `createMcpHandler` so there's no session bookkeeping to hand-roll — HTTP is also what makes a browser-based OAuth login possible in the first place (Part 3 swaps in 3-legged auth without touching this wiring at all).
- Swap **2-legged** app authentication for **3-legged** user OAuth so the server acts as a real Autodesk user, complete with an `/auth/callback` route (kept as a single shared login for workshop simplicity — Part 3 explains that tradeoff and what a real per-user setup would need).
- Add a new `preview-design` tool that returns an embedded **APS Viewer** UI resource, letting the AI render 3D models directly in the chat.

> **Prerequisite:** You should have completed the beginner workshop, or be comfortable with the codebase it produced (`aps.js`, `mcp.js`, `index.js` with the two read-only tools).

## Sessions

- [Prerequisites](0-prerequisites.md)
- [Part 1: Project Setup](1-project-setup.md)
- [Part 2: Streamable HTTP Transport](2-http-transport.md)
- [Part 3: 3-Legged Authentication](3-user-auth.md)
- [Part 4: Embedded Design Viewer](4-design-viewer.md)
- [Extras](extras.md)
