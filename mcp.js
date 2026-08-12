import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHubsProjects, getFolderContents, getItemTip } from './aps.js';
import VIEWER_HTML from './dist/viewer.js';
import { PUBLIC_URL, VIEWER_RESOURCE_URI, VIEWER_RESOURCE_MIME_TYPE, VIEWER_DOMAINS, MCP_SERVER_NAME, MCP_SERVER_VERSION } from './config.js';

export function createMcpServer(authenticationProvider, state) {
    const server = new McpServer({
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
    });

    const withAuth = (handler) => async (input) => {
        if (!authenticationProvider.isAuthenticated()) {
            const authUrl = authenticationProvider.getAuthorizationUrl(state);
            return { content: [{ type: 'text', text: `Authentication is required. Please log in at: ${authUrl}` }] };
        }
        return await handler(input);
    };

    server.registerTool(
        'list-hubs-projects',
        {
            description: 'Lists all hubs and their projects available to the authenticated user.'
        },
        withAuth(async () => {
            const hubs = await getHubsProjects(authenticationProvider);
            return { content: [{ type: 'text', text: JSON.stringify(hubs, null, 2) }] };
        })
    );

    server.registerTool(
        'list-folder-contents',
        {
            description: 'Lists the contents of a folder in a project, or top-level folders if no folder ID is provided.',
            inputSchema: z.object({
                hubId: z.string().describe('Hub ID.'),
                projectId: z.string().describe('Project ID.'),
                folderId: z.string().optional().describe('Folder ID. Omit to list top-level folders.'),
            })
        },
        withAuth(async ({ hubId, projectId, folderId }) => {
            const items = await getFolderContents(hubId, projectId, folderId, authenticationProvider);
            return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        })
    );

    server.registerTool(
        'preview-design',
        {
            description: 'Displays an interactive 3D preview of a design in APS Viewer. Use this when the user wants to visualise, inspect, or explore a design file.',
            inputSchema: z.object({
                projectId: z.string().describe('Project ID the design belongs to.'),
                designId: z.string().describe('Item ID of the design to preview.'),
                region: z.string().optional().describe('Hub region (e.g. "US", "EMEA"). Defaults to "US".'),
            }),
            _meta: {
                ui: { resourceUri: VIEWER_RESOURCE_URI },
            },
        },
        withAuth(async ({ projectId, designId, region = 'US' }) => {
            const accessToken = await authenticationProvider.getAccessToken();
            const tip = await getItemTip(projectId, designId, authenticationProvider);
            const config = {
                accessToken,
                env: 'AutodeskProduction2',
                api: region === 'US' ? 'streamingV2' : `streamingV2_${region}`,
            };
            return {
                structuredContent: { name: tip.name, urn: tip.derivativeUrn, config },
                content: [{ type: 'text', text: `Here is the preview of ${tip.name}.` }],
            };
        })
    );

    server.registerResource(
        'viewer',
        VIEWER_RESOURCE_URI,
        { mimeType: VIEWER_RESOURCE_MIME_TYPE },
        async (uri) => ({
            contents: [{
                uri: uri.toString(),
                mimeType: VIEWER_RESOURCE_MIME_TYPE,
                text: VIEWER_HTML,
                _meta: {
                    ui: {
                        domain: PUBLIC_URL,
                        csp: {
                            resourceDomains: [...VIEWER_DOMAINS, 'blob:', 'data:'],
                            connectDomains: [...VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                        },
                    },
                },
            }]
        })
    );

    return server;
}
