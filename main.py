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
        mcp_server = create_mcp_server(auth_provider, auth_url, PUBLIC_URL)
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
