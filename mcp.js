import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getHubsProjects, getFolderContents, getItemTip } from './aps.js';

const VIEWER_HTML = readFileSync(new URL('./viewer.html', import.meta.url), 'utf-8');

const VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html';
const VIEWER_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';
const VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
];
const VIEWER_SCRIPT_DOMAINS = ['https://cdn.jsdelivr.net'];

export function createMcpServer(authenticationProvider, publicUrl) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        title: 'APS MCP Server',
        version: '1.0.0'
    });

    server.registerTool(
        'list-hubs-projects',
        {
            title: 'List hubs and projects',
            description: 'Lists all hubs and their projects available to the authenticated user.',
            annotations: { readOnlyHint: true }
        },
        async () => {
            const hubs = await getHubsProjects(authenticationProvider);
            return { content: [{ type: 'text', text: JSON.stringify(hubs, null, 2) }] };
        }
    );

    server.registerTool(
        'list-folder-contents',
        {
            title: 'List folder contents',
            description: 'Lists the contents of a folder in a project, or top-level folders if no folder ID is provided.',
            inputSchema: z.object({
                hubId: z.string().describe('Hub ID.'),
                projectId: z.string().describe('Project ID.'),
                folderId: z.string().optional().describe('Folder ID. Omit to list top-level folders.'),
            }),
            annotations: { readOnlyHint: true }
        },
        async ({ hubId, projectId, folderId }) => {
            const items = await getFolderContents(authenticationProvider, hubId, projectId, folderId);
            return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] };
        }
    );

    server.registerTool(
        'preview-design',
        {
            title: 'Preview design',
            description: 'Displays an interactive 3D preview of a design in APS Viewer. Use this when the user wants to visualise, inspect, or explore a design file.',
            inputSchema: z.object({
                projectId: z.string().describe('Project ID the design belongs to.'),
                designId: z.string().describe('Item ID of the design to preview.'),
                region: z.string().optional().describe('Hub region (e.g. "US", "EMEA"). Defaults to "US".'),
            }),
            _meta: {
                ui: { resourceUri: VIEWER_RESOURCE_URI },
            },
            annotations: { readOnlyHint: true }
        },
        async ({ projectId, designId, region = 'US' }) => {
            const accessToken = await authenticationProvider.getAccessToken();
            const tip = await getItemTip(authenticationProvider, projectId, designId);
            const config = {
                accessToken,
                env: 'AutodeskProduction2',
                api: region === 'US' ? 'streamingV2' : `streamingV2_${region}`,
            };
            return {
                structuredContent: { name: tip.name, urn: tip.derivativeUrn, config },
                content: [{ type: 'text', text: `Here is the preview of ${tip.name}.` }],
            };
        }
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
                        domain: publicUrl,
                        csp: {
                            resourceDomains: [...VIEWER_DOMAINS, ...VIEWER_SCRIPT_DOMAINS, 'blob:', 'data:'],
                            connectDomains: [...VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                        },
                    },
                },
            }]
        })
    );

    return server;
}
