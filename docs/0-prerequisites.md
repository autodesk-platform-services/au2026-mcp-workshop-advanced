# Prerequisites

Complete these steps **before the workshop**. They take roughly 20 minutes.

## Starting code

This session runs in parallel with the [AU2026 MCP Workshop: Beginner](https://github.com/autodesk-platform-services/au2026-mcp-workshop-beginner), and starts where that one finishes. You don't need to have attended it — the beginner repository is the starting point, and Part 1 shows you how to get it.

What matters is that you're comfortable with the code it produces: a small MCP server (`aps.js`, `mcp.js`, `index.js`) with two read-only tools over a STDIO transport.

## Autodesk Platform Services

If this is the first time you're working with APS, create a new account and a developer hub:

- [Create an account](https://get-started.aps.autodesk.com/#create-an-account)
- [Create a developer hub](https://get-started.aps.autodesk.com/#create-a-developer-hub)

Then, create a new **Traditional Web App** application:

- [Create app credentials](https://get-started.aps.autodesk.com/#create-app-credentials)

Copy the **Client ID** and **Client Secret** — you'll need both. Leave the **Callback URL** for now. It has to match the public URL of your server, which you only learn once your GitHub Codespace is running. Part 2 walks you through registering it.

## Access to Forma

An administrator must add your APS application to a Forma hub under **Hub Admin → Custom Integrations**. Because the new MCP server acts on behalf of *a user*, you also need to be **a member of at least one project in that hub** — otherwise the tools return an empty list even though the code works correctly.

## GitHub, Codespaces, Copilot

Sign in to [GitHub](https://github.com), then confirm both services are actually enabled on your account. A missing entitlement is the one problem you can't fix during the session, so check rather than assume.

### Codespaces

1. Open [github.com/codespaces](https://github.com/codespaces). A **New codespace** button means Codespaces is enabled for your account. An error page, or no button, means it isn't.
2. Open [github.com/settings/billing](https://github.com/settings/billing) and find the **Codespaces** usage. The free tier's included hours are enough — the workshop uses about two hours on a 2-core machine — but you need some left.
3. If the button is missing because an organisation policy blocks Codespaces, use a personal GitHub account for the workshop.

You don't need to create a Codespace yet. Part 1 does that.

### Copilot

1. Open [github.com/settings/copilot](https://github.com/settings/copilot). It should report an active plan; **Copilot Free** is enough.
2. Open [github.com/copilot](https://github.com/copilot) and send any prompt. A reply confirms the plan is live, not just assigned.
3. In VS Code, open Copilot Chat and check that the mode dropdown at the bottom of the chat panel offers **Agent**. The workshop drives your MCP server from agent mode — no other mode calls tools.

## Verify your setup

You're ready when:

- [x] You have an APS **Client ID** and **Client Secret**
- [x] You are a member of at least one project in the Forma hub your APS app is provisioned to
- [x] [github.com/codespaces](https://github.com/codespaces) offers you a **New codespace** button, with included hours remaining
- [x] Copilot answers a prompt at [github.com/copilot](https://github.com/copilot), and Copilot Chat in VS Code offers **Agent** mode

The workshop instructor will do a quick setup check at the start of the session.
