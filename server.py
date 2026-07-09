import functools
import json
from pathlib import Path
from typing import Annotated

from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, TextContent
from pydantic import Field

from aps import get_hubs_projects, get_folder_contents, get_item_tip

VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html'
VIEWER_MIME_TYPE = 'text/html;profile=mcp-app'
VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
]
VIEWER_HTML = (Path(__file__).parent / 'dist' / 'viewer.html').read_text()


def create_mcp_server(authentication_provider, auth_url, public_url):
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

    @mcp.tool(
        name='preview-design',
        description='Displays an interactive 3D preview of a design in APS Viewer. Use this when the user wants to visualise, inspect, or explore a design file.',
        meta={'ui': {'resourceUri': VIEWER_RESOURCE_URI}},
        structured_output=False,
    )
    @with_auth
    def preview_design(
        project_id: Annotated[str, Field(description='Project ID the design belongs to.')],
        design_id: Annotated[str, Field(description='Item ID of the design to preview.')],
        region: Annotated[str, Field(description='Hub region (e.g. "US", "EMEA"). Defaults to "US".')] = 'US',
    ) -> CallToolResult:
        access_token = authentication_provider.get_access_token()
        tip = get_item_tip(project_id, design_id, authentication_provider)
        config = {
            'accessToken': access_token,
            'env': 'AutodeskProduction2',
            'api': 'streamingV2' if region == 'US' else f'streamingV2_{region}',
        }
        return CallToolResult(
            structuredContent={'name': tip['name'], 'urn': tip['derivative_urn'], 'config': config},
            content=[TextContent(type='text', text=f'Here is the preview of {tip["name"]}.')],
        )

    @mcp.resource(
        VIEWER_RESOURCE_URI,
        name='viewer',
        mime_type=VIEWER_MIME_TYPE,
        meta={
            'ui': {
                'domain': public_url,
                'csp': {
                    'resourceDomains': [*VIEWER_DOMAINS, 'blob:', 'data:'],
                    'connectDomains': [*VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                },
            },
        },
    )
    def viewer() -> str:
        return VIEWER_HTML

    return mcp
