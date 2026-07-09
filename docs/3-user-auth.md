# Part 3: User Authentication

In this section you'll swap the 2-legged `AppAuthenticationProvider` for a `UserAuthenticationProvider` that holds a real user's access + refresh tokens. The HTTP transport from Part 2 makes this practical: each session gets its own provider, and a new `/auth/callback` route on the Starlette app completes the OAuth dance. The data helpers (`get_hubs_projects`, `get_folder_contents`) stay exactly as they are — both providers expose the same `get_access_token()` interface, which is the whole reason the provider pattern exists.

## Theory

### Why 3-legged?

2-legged tokens are issued *to your application*. They are great for service-to-service automation, but they cannot see anything a Forma user owns unless the hub administrator explicitly delegates it. As soon as the AI should "act as the user" — show their projects, their permissions, files they personally have access to — you need a **3-legged** token.

The flow is:

1. Send the user to `https://developer.api.autodesk.com/authentication/v2/authorize` with your client ID, the requested scopes, a redirect URL, and a `state` value.
2. The user signs in and consents. Autodesk redirects back to your callback URL with a one-time `code`.
3. Your server exchanges the `code` for an `access_token` and a `refresh_token`. For a confidential client (one with a client secret, like this workshop's), APS expects the client credentials as an HTTP Basic `Authorization` header on this request — not in the form body.
4. The access token expires after about an hour. Use the refresh token to mint new ones without prompting the user again.

### Per-session providers

In Part 2 the whole process shared a single `AppAuthenticationProvider`. With user tokens that won't work — each session must hold its own credentials. We'll keep a single `sessions` dict keyed by session ID, where each entry bundles that session's transport **and** its own `UserAuthenticationProvider`. The session ID doubles as the OAuth `state` parameter, so the callback knows which provider to populate.

### Login URL elicitation — and the fallback

MCP defines an "elicit input" capability that lets a server ask the client (Copilot) to open a URL on the user's behalf. Today, GitHub Copilot does **not** implement URL elicitation. So instead of relying on it, we return the authorization URL as plain text inside the first tool result and let the user click it manually. The mechanism is crude but works in every MCP client.

## Step 1: User authentication provider

There is no official APS SDK for Python, so — same as the beginner session — you'll call the OAuth REST API directly with `requests`. Open `aps.py` and replace the `AppAuthenticationProvider` class with the user-level equivalent:

```python
import time
from urllib.parse import urlencode

import requests

APS_BASE_URL = 'https://developer.api.autodesk.com'
SCOPES = 'data:read'


class UserAuthenticationProvider:
    def __init__(self, client_id, client_secret, callback_url):
        self.client_id = client_id
        self.client_secret = client_secret
        self.callback_url = callback_url
        self.cache = {'access_token': None, 'refresh_token': None, 'expires_at': 0}

    def is_authenticated(self):
        return bool(self.cache['access_token']) and self.cache['expires_at'] > time.time()

    def get_access_token(self):
        if self.cache['access_token'] and self.cache['expires_at'] > time.time():
            return self.cache['access_token']
        elif self.cache['refresh_token']:
            self.refresh_access_token()
            return self.cache['access_token']
        else:
            raise RuntimeError('Not authenticated')
```

Each instance holds its own `client_id`, `client_secret`, and `callback_url` — unlike the beginner's `AppAuthenticationProvider`, there is no module-level shared state; every user session is independent.

Key differences from the beginner provider:

- The cache holds **both** an access token (short-lived) and a refresh token (long-lived).
- `is_authenticated()` checks that the token both exists and hasn't expired. The MCP server calls this to decide whether to return a login URL instead of running the tool.
- `get_access_token()` returns the cached token, refreshes it silently using the refresh token, or raises `RuntimeError('Not authenticated')` if the user hasn't completed OAuth yet.

## Step 2: Authorization URL & code exchange

Add these methods to `UserAuthenticationProvider`:

```python
    def get_authorization_url(self, state):
        params = {
            'response_type': 'code',
            'client_id': self.client_id,
            'redirect_uri': self.callback_url,
            'scope': SCOPES,
            'state': state,
        }
        return f'{APS_BASE_URL}/authentication/v2/authorize?{urlencode(params)}'

    def exchange_auth_code(self, code):
        response = requests.post(
            f'{APS_BASE_URL}/authentication/v2/token',
            auth=(self.client_id, self.client_secret),
            data={'grant_type': 'authorization_code', 'code': code, 'redirect_uri': self.callback_url},
        )
        response.raise_for_status()
        self._cache_credentials(response.json())

    def refresh_access_token(self):
        response = requests.post(
            f'{APS_BASE_URL}/authentication/v2/token',
            auth=(self.client_id, self.client_secret),
            data={'grant_type': 'refresh_token', 'refresh_token': self.cache['refresh_token']},
        )
        response.raise_for_status()
        self._cache_credentials(response.json())

    def _cache_credentials(self, credentials):
        self.cache['access_token'] = credentials['access_token']
        self.cache['refresh_token'] = credentials['refresh_token']
        self.cache['expires_at'] = time.time() + credentials['expires_in']
```

- `get_authorization_url(state)` builds the redirect URL using the `callback_url` stored at construction time. `state` is the MCP session ID — the OAuth server sends it back to the callback so we know which provider to populate.
- `exchange_auth_code(code)` and `refresh_access_token()` both call the same `/authentication/v2/token` endpoint. Passing `auth=(self.client_id, self.client_secret)` tells `requests` to send an HTTP Basic `Authorization` header — this is how APS expects a confidential client to authenticate for these two grant types (the 2-legged `client_credentials` grant from the beginner session is the exception: APS also accepts those credentials directly in the body there).
- `_cache_credentials(credentials)` is shared by both methods so the token-storing logic isn't duplicated.

## Step 3: Keep the data helpers, add `get_item_tip`

The existing `get_hubs_projects` and `get_folder_contents` functions are unchanged — both `AppAuthenticationProvider` and `UserAuthenticationProvider` satisfy the `get_access_token()` interface these helpers depend on.

While you're here, add one more helper that Part 4 will need: `get_item_tip` returns the latest version's name and derivative URN for a design.

```python
def get_item_tip(project_id, item_id, authentication_provider):
    headers = {'Authorization': f'Bearer {authentication_provider.get_access_token()}'}
    response = requests.get(f'{APS_BASE_URL}/data/v1/projects/{project_id}/items/{item_id}/tip', headers=headers)
    response.raise_for_status()
    data = response.json()['data']
    return {
        'name': data['attributes']['displayName'],
        'derivative_urn': data['relationships']['derivatives']['data']['id'],
    }
```

## Step 4: Login-gated tool handlers

A 3-legged session has no tokens until the user has logged in. The MCP tools need to detect that and respond with the authorization URL instead of crashing with `RuntimeError('Not authenticated')`.

Update `server.py` so the factory accepts the login URL alongside the auth provider, and wraps each handler in a small `with_auth` decorator that short-circuits to a login prompt when the session isn't authenticated yet:

```python
import functools
import json
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from aps import get_hubs_projects, get_folder_contents


def create_mcp_server(authentication_provider, auth_url):
    mcp = FastMCP(name='aps-mcp-server', instructions='MCP server for Autodesk Platform Services')

    def with_auth(handler):
        @functools.wraps(handler)
        def wrapper(*args, **kwargs):
            if not authentication_provider.is_authenticated():
                return f'Authentication is required. Please log in at: {auth_url}'
            return handler(*args, **kwargs)
        return wrapper

    @mcp.tool(
        name='list-hubs-projects',
        description='Lists all hubs and their projects available to the authenticated user.',
        structured_output=False,
    )
    @with_auth
    def list_hubs_projects() -> str:
        hubs = get_hubs_projects(authentication_provider)
        return json.dumps(hubs, indent=2)

    @mcp.tool(
        name='list-folder-contents',
        description='Lists the contents of a folder in a project, or top-level folders if no folder ID is provided.',
        structured_output=False,
    )
    @with_auth
    def list_folder_contents(
        hub_id: Annotated[str, Field(description='Hub ID.')],
        project_id: Annotated[str, Field(description='Project ID.')],
        folder_id: Annotated[str | None, Field(description='Folder ID. Omit to list top-level folders.')] = None,
    ) -> str:
        items = get_folder_contents(hub_id, project_id, folder_id, authentication_provider)
        return json.dumps(items, indent=2)

    return mcp
```

The factory now **receives** the login URL — `main.py` computes it once (Step 5) and passes it in, keeping the factory free of session bookkeeping. `with_auth` uses `functools.wraps` so FastMCP still sees the wrapped function's real signature (and therefore still derives the correct input schema) even though every tool handler is now wrapped: when the session isn't yet authenticated it returns a short string containing the login URL for the AI to show the user; otherwise it runs the real handler and returns its result unchanged.

## Step 5: Per-session providers + callback route

The HTTP entry point from Part 2 used one shared `AppAuthenticationProvider`. Refactor it so each session gets its own `UserAuthenticationProvider` and login URL, and add the `/auth/callback` route that completes the OAuth exchange:

```python
import contextlib
import os
import sys
import uuid
from dataclasses import dataclass

import anyio
import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route

from mcp.server.streamable_http import MCP_SESSION_ID_HEADER, StreamableHTTPServerTransport

from aps import UserAuthenticationProvider
from server import create_mcp_server

APS_CLIENT_ID = os.environ.get('APS_CLIENT_ID')
APS_CLIENT_SECRET = os.environ.get('APS_CLIENT_SECRET')
if not APS_CLIENT_ID or not APS_CLIENT_SECRET:
    print('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.', file=sys.stderr)
    sys.exit(1)
PORT = int(os.environ.get('PORT', '3000'))
PUBLIC_URL = os.environ.get('PUBLIC_URL', f'http://localhost:{PORT}')
CALLBACK_URL = f'{PUBLIC_URL}/auth/callback'


@dataclass
class Session:
    transport: StreamableHTTPServerTransport
    auth_provider: UserAuthenticationProvider


sessions: dict[str, Session] = {}
task_group: anyio.abc.TaskGroup | None = None


async def run_session(transport, mcp_server, session_id, *, task_status):
    async with transport.connect() as (read_stream, write_stream):
        task_status.started()
        try:
            await mcp_server._mcp_server.run(
                read_stream, write_stream, mcp_server._mcp_server.create_initialization_options()
            )
        except Exception as err:
            print(f'Session {session_id} crashed:', err, file=sys.stderr)
        finally:
            sessions.pop(session_id, None)


async def mcp_app(scope, receive, send):
    request = Request(scope, receive)
    session_id = request.headers.get(MCP_SESSION_ID_HEADER)

    if session_id and session_id in sessions:
        await sessions[session_id].transport.handle_request(scope, receive, send)
    elif not session_id:
        new_session_id = uuid.uuid4().hex
        transport = StreamableHTTPServerTransport(mcp_session_id=new_session_id)
        auth_provider = UserAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET, CALLBACK_URL)
        sessions[new_session_id] = Session(transport, auth_provider)
        auth_url = auth_provider.get_authorization_url(new_session_id)
        mcp_server = create_mcp_server(auth_provider, auth_url)
        assert task_group is not None
        await task_group.start(run_session, transport, mcp_server, new_session_id)
        await transport.handle_request(scope, receive, send)
    else:
        response = JSONResponse(
            {
                'jsonrpc': '2.0',
                'error': {'code': -32000, 'message': 'Bad Request: No valid session ID provided'},
                'id': None,
            },
            status_code=400,
        )
        await response(scope, receive, send)


async def auth_callback(request):
    code = request.query_params.get('code')
    session_id = request.query_params.get('state')
    if not code or not session_id:
        return PlainTextResponse('Missing code or state parameter.', status_code=400)
    session = sessions.get(session_id)
    if not session:
        return PlainTextResponse('Invalid or expired session ID.', status_code=400)
    try:
        session.auth_provider.exchange_auth_code(code)
        return PlainTextResponse('Login successful! You can close this window and return to your AI assistant.')
    except Exception as err:
        print('Auth callback error:', err, file=sys.stderr)
        return PlainTextResponse('Authentication failed.', status_code=500)


@contextlib.asynccontextmanager
async def lifespan(app):
    global task_group
    async with anyio.create_task_group() as tg:
        task_group = tg
        yield
        tg.cancel_scope.cancel()


app = Starlette(
    routes=[
        Mount('/mcp', app=mcp_app),
        Route('/auth/callback', auth_callback, methods=['GET']),
    ],
    middleware=[
        Middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], expose_headers=['Mcp-Session-Id']),
    ],
    lifespan=lifespan,
)

uvicorn.run(app, host='0.0.0.0', port=PORT)
```

The diff from Part 2:

- The single `transports` dict becomes a `sessions` dict whose entries each bundle a transport with that session's own `UserAuthenticationProvider`, using a small `Session` dataclass to hold the pair.
- We generate the session ID up front with `uuid.uuid4().hex` and pass it to `StreamableHTTPServerTransport`. Because the ID is known synchronously we build the provider, derive its login URL with `get_authorization_url(new_session_id)`, and register the session immediately — no separate "session initialized" callback needed. The `finally` block in `run_session` removes the entry once the session ends.
- A request whose `Mcp-Session-Id` header matches a stored session is served from that session's transport. A request with no session header always gets a new one.
- The provider is constructed with the callback URL baked in (`CALLBACK_URL`), and the entry point passes the login URL into the factory via `create_mcp_server(auth_provider, auth_url)` — the factory itself stays out of session bookkeeping.
- A new `/auth/callback` route (a regular Starlette `Route`, unlike the raw-ASGI `/mcp` mount — it only ever sends back one plain-text response, so there's no need for direct `scope`/`receive`/`send` access) resolves the right provider from the `sessions` dict via the `state` query parameter and calls `session.auth_provider.exchange_auth_code(code)`. No callback URL argument is needed because it was stored at construction time.

## Checkpoint

You should now have:

- [x] `UserAuthenticationProvider` (with `get_authorization_url` and `exchange_auth_code` as instance methods) and `get_item_tip` in `aps.py`
- [x] `server.py` with a `with_auth` decorator guarding both tool handlers
- [x] `main.py` allocating per-session auth providers and serving `/auth/callback`

<details>
    <summary>
        Reference: full <code>aps.py</code>
    </summary>

```python
import time
from urllib.parse import urlencode

import requests

APS_BASE_URL = 'https://developer.api.autodesk.com'
SCOPES = 'data:read'


class UserAuthenticationProvider:
    def __init__(self, client_id, client_secret, callback_url):
        self.client_id = client_id
        self.client_secret = client_secret
        self.callback_url = callback_url
        self.cache = {'access_token': None, 'refresh_token': None, 'expires_at': 0}

    def is_authenticated(self):
        return bool(self.cache['access_token']) and self.cache['expires_at'] > time.time()

    def get_authorization_url(self, state):
        params = {
            'response_type': 'code',
            'client_id': self.client_id,
            'redirect_uri': self.callback_url,
            'scope': SCOPES,
            'state': state,
        }
        return f'{APS_BASE_URL}/authentication/v2/authorize?{urlencode(params)}'

    def exchange_auth_code(self, code):
        response = requests.post(
            f'{APS_BASE_URL}/authentication/v2/token',
            auth=(self.client_id, self.client_secret),
            data={'grant_type': 'authorization_code', 'code': code, 'redirect_uri': self.callback_url},
        )
        response.raise_for_status()
        self._cache_credentials(response.json())

    def refresh_access_token(self):
        response = requests.post(
            f'{APS_BASE_URL}/authentication/v2/token',
            auth=(self.client_id, self.client_secret),
            data={'grant_type': 'refresh_token', 'refresh_token': self.cache['refresh_token']},
        )
        response.raise_for_status()
        self._cache_credentials(response.json())

    def _cache_credentials(self, credentials):
        self.cache['access_token'] = credentials['access_token']
        self.cache['refresh_token'] = credentials['refresh_token']
        self.cache['expires_at'] = time.time() + credentials['expires_in']

    def get_access_token(self):
        if self.cache['access_token'] and self.cache['expires_at'] > time.time():
            return self.cache['access_token']
        elif self.cache['refresh_token']:
            self.refresh_access_token()
            return self.cache['access_token']
        else:
            raise RuntimeError('Not authenticated')


def get_hubs_projects(authentication_provider):
    headers = {'Authorization': f'Bearer {authentication_provider.get_access_token()}'}
    response = requests.get(f'{APS_BASE_URL}/project/v1/hubs', headers=headers)
    response.raise_for_status()
    hubs = response.json().get('data', [])
    results = []
    for hub in hubs:
        response = requests.get(f'{APS_BASE_URL}/project/v1/hubs/{hub["id"]}/projects', headers=headers)
        response.raise_for_status()
        projects = response.json().get('data', [])
        results.append({
            'id': hub['id'],
            'name': hub['attributes']['name'],
            'region': hub['attributes']['region'],
            'projects': [{'id': p['id'], 'name': p['attributes']['name']} for p in projects],
        })
    return results


def get_folder_contents(hub_id, project_id, folder_id, authentication_provider):
    headers = {'Authorization': f'Bearer {authentication_provider.get_access_token()}'}
    if folder_id:
        url = f'{APS_BASE_URL}/data/v1/projects/{project_id}/folders/{folder_id}/contents'
    else:
        url = f'{APS_BASE_URL}/project/v1/hubs/{hub_id}/projects/{project_id}/topFolders'
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    items = response.json().get('data', [])
    return [
        {
            'type': item['type'],
            'id': item['id'],
            'name': item['attributes']['displayName'],
            'modified_at': item['attributes']['lastModifiedTime'],
            'modified_by': item['attributes']['lastModifiedUserName'],
        }
        for item in items
    ]


def get_item_tip(project_id, item_id, authentication_provider):
    headers = {'Authorization': f'Bearer {authentication_provider.get_access_token()}'}
    response = requests.get(f'{APS_BASE_URL}/data/v1/projects/{project_id}/items/{item_id}/tip', headers=headers)
    response.raise_for_status()
    data = response.json()['data']
    return {
        'name': data['attributes']['displayName'],
        'derivative_urn': data['relationships']['derivatives']['data']['id'],
    }
```

</details>

<details>
    <summary>
        Reference: full <code>server.py</code>
    </summary>

```python
import functools
import json
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from pydantic import Field

from aps import get_hubs_projects, get_folder_contents


def create_mcp_server(authentication_provider, auth_url):
    mcp = FastMCP(name='aps-mcp-server', instructions='MCP server for Autodesk Platform Services')

    def with_auth(handler):
        @functools.wraps(handler)
        def wrapper(*args, **kwargs):
            if not authentication_provider.is_authenticated():
                return f'Authentication is required. Please log in at: {auth_url}'
            return handler(*args, **kwargs)
        return wrapper

    @mcp.tool(
        name='list-hubs-projects',
        description='Lists all hubs and their projects available to the authenticated user.',
        structured_output=False,
    )
    @with_auth
    def list_hubs_projects() -> str:
        hubs = get_hubs_projects(authentication_provider)
        return json.dumps(hubs, indent=2)

    @mcp.tool(
        name='list-folder-contents',
        description='Lists the contents of a folder in a project, or top-level folders if no folder ID is provided.',
        structured_output=False,
    )
    @with_auth
    def list_folder_contents(
        hub_id: Annotated[str, Field(description='Hub ID.')],
        project_id: Annotated[str, Field(description='Project ID.')],
        folder_id: Annotated[str | None, Field(description='Folder ID. Omit to list top-level folders.')] = None,
    ) -> str:
        items = get_folder_contents(hub_id, project_id, folder_id, authentication_provider)
        return json.dumps(items, indent=2)

    return mcp
```

</details>

<details>
    <summary>
        Reference: full <code>main.py</code>
    </summary>

```python
import contextlib
import os
import sys
import uuid
from dataclasses import dataclass

import anyio
import uvicorn
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, PlainTextResponse
from starlette.routing import Mount, Route

from mcp.server.streamable_http import MCP_SESSION_ID_HEADER, StreamableHTTPServerTransport

from aps import UserAuthenticationProvider
from server import create_mcp_server

APS_CLIENT_ID = os.environ.get('APS_CLIENT_ID')
APS_CLIENT_SECRET = os.environ.get('APS_CLIENT_SECRET')
if not APS_CLIENT_ID or not APS_CLIENT_SECRET:
    print('APS_CLIENT_ID and APS_CLIENT_SECRET environment variables are required.', file=sys.stderr)
    sys.exit(1)
PORT = int(os.environ.get('PORT', '3000'))
PUBLIC_URL = os.environ.get('PUBLIC_URL', f'http://localhost:{PORT}')
CALLBACK_URL = f'{PUBLIC_URL}/auth/callback'


@dataclass
class Session:
    transport: StreamableHTTPServerTransport
    auth_provider: UserAuthenticationProvider


sessions: dict[str, Session] = {}
task_group: anyio.abc.TaskGroup | None = None


async def run_session(transport, mcp_server, session_id, *, task_status):
    async with transport.connect() as (read_stream, write_stream):
        task_status.started()
        try:
            await mcp_server._mcp_server.run(
                read_stream, write_stream, mcp_server._mcp_server.create_initialization_options()
            )
        except Exception as err:
            print(f'Session {session_id} crashed:', err, file=sys.stderr)
        finally:
            sessions.pop(session_id, None)


async def mcp_app(scope, receive, send):
    request = Request(scope, receive)
    session_id = request.headers.get(MCP_SESSION_ID_HEADER)

    if session_id and session_id in sessions:
        await sessions[session_id].transport.handle_request(scope, receive, send)
    elif not session_id:
        new_session_id = uuid.uuid4().hex
        transport = StreamableHTTPServerTransport(mcp_session_id=new_session_id)
        auth_provider = UserAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET, CALLBACK_URL)
        sessions[new_session_id] = Session(transport, auth_provider)
        auth_url = auth_provider.get_authorization_url(new_session_id)
        mcp_server = create_mcp_server(auth_provider, auth_url)
        assert task_group is not None
        await task_group.start(run_session, transport, mcp_server, new_session_id)
        await transport.handle_request(scope, receive, send)
    else:
        response = JSONResponse(
            {
                'jsonrpc': '2.0',
                'error': {'code': -32000, 'message': 'Bad Request: No valid session ID provided'},
                'id': None,
            },
            status_code=400,
        )
        await response(scope, receive, send)


async def auth_callback(request):
    code = request.query_params.get('code')
    session_id = request.query_params.get('state')
    if not code or not session_id:
        return PlainTextResponse('Missing code or state parameter.', status_code=400)
    session = sessions.get(session_id)
    if not session:
        return PlainTextResponse('Invalid or expired session ID.', status_code=400)
    try:
        session.auth_provider.exchange_auth_code(code)
        return PlainTextResponse('Login successful! You can close this window and return to your AI assistant.')
    except Exception as err:
        print('Auth callback error:', err, file=sys.stderr)
        return PlainTextResponse('Authentication failed.', status_code=500)


@contextlib.asynccontextmanager
async def lifespan(app):
    global task_group
    async with anyio.create_task_group() as tg:
        task_group = tg
        yield
        tg.cancel_scope.cancel()


app = Starlette(
    routes=[
        Mount('/mcp', app=mcp_app),
        Route('/auth/callback', auth_callback, methods=['GET']),
    ],
    middleware=[
        Middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], expose_headers=['Mcp-Session-Id']),
    ],
    lifespan=lifespan,
)

uvicorn.run(app, host='0.0.0.0', port=PORT)
```

</details>

### Try it out

1. Restart the server: `python main.py`.
2. In VS Code, open a fresh Copilot Chat (a new chat triggers a new MCP session, which is what you want).
3. Ask: *"What Forma projects do I have access to?"*
4. The first tool call returns the "Authentication required" message with a URL.
5. Open the URL in a browser, sign in with your Autodesk account, and see the *"Login successful!"* page.
6. Re-run the same prompt. The tool now returns the hubs and projects that **your user** can see — which may differ from the application-level results you got in Part 2.

> **Multiple sessions.** Open a second Copilot Chat to confirm sessions are independent. The second one will demand its own login URL because its session ID and auth provider are new.

### Additional resources

- [APS 3-legged OAuth tutorial](https://aps.autodesk.com/en/docs/oauth/v2/tutorials/get-3-legged-token/)
- [APS Authentication API reference](https://aps.autodesk.com/en/docs/oauth/v2/reference/http/)
