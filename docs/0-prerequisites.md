# Prerequisites

Complete these steps **before the workshop**. They take roughly 20–30 minutes, and most of them mirror the beginner session — only the **Callback URL** is new.

## Beginner workshop

This session continues from the [AU2026 MCP Workshop: Beginner](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner). You don't need to have finished it live, but you should have:

- A working clone of the beginner repository, **or**
- Familiarity with the code it produces: `aps.js` (2-legged `AppAuthenticationProvider`, `getHubsProjects`, `getFolderContents`), `mcp.js` (factory with two tools), and a STDIO-based `index.js`.

The advanced workshop replaces parts of those files. You'll see the original snippets in each section so you can follow along even if you start fresh.

## Autodesk Platform Services

You need an APS application with a **Callback URL** configured — without it, the 3-legged OAuth flow in Part 2 won't work.

1. Go to [https://aps.autodesk.com](https://aps.autodesk.com) and sign in.
2. Open **My Apps** and either reuse the application from the beginner workshop or create a new **Traditional Web App**.
3. In the application settings, set **Callback URL** to:

   ```text
   http://localhost:3000/auth/callback
   ```

   If you plan to host the server somewhere reachable from the public internet (e.g. a Codespace forwarded port), add that URL too — APS lets you register multiple callbacks.
4. Copy the **Client ID** and **Client Secret**.

> **APS documentation:** [Get a 3-legged token](https://aps.autodesk.com/en/docs/oauth/v2/tutorials/get-3-legged-token/)

## Access to Forma

Same as the beginner session: an administrator must add your APS application to a Forma hub under **Hub Admin → Custom Integrations**. The 3-legged flow uses *the signed-in user's* permissions, so you also need to be **a member of at least one project in that hub** — otherwise the tools in Part 3 will return an empty list even though the code is working correctly.

## GitHub, Codespaces, Copilot

1. Sign in to [GitHub](https://github.com).
2. Confirm access to **GitHub Codespaces** (free tier is enough).
3. Confirm access to **GitHub Copilot** — required to test the embedded viewer in Part 4.

> If you ran the beginner workshop from a Codespace, you can reuse it. Just make sure the **Callback URL** in your APS app matches the URL your Codespace forwards `3000` to.

## Verify your setup

You're ready when:

- [x] Your APS app has a Callback URL ending in `/auth/callback`
- [x] You have the beginner workshop code (or are happy to retype the small pieces it provides)
- [x] You are a member of at least one project in the Forma hub your APS app is provisioned to
- [x] You can open VS Code with Copilot in agent mode

The workshop instructor will do a quick setup check at the start of the session.
