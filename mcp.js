import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool, registerAppResource } from '@modelcontextprotocol/ext-apps/server';
import { getHubsProjects, getFolderContents, getItemTip } from './aps.js';
import VIEWER_HTML from './dist/viewer.js';

const VIEWER_RESOURCE_URI = 'ui://aps-mcp/viewer.html';
const VIEWER_DOMAINS = [
    'https://developer.api.autodesk.com',
    'https://cdn.derivative.autodesk.com',
    'https://fonts.autodesk.com',
];

export function createMcpServer(authenticationProvider, publicUrl, authUrl) {
    const server = new McpServer({
        name: 'aps-mcp-server',
        description: 'MCP server for Autodesk Platform Services',
        version: '1.0.0'
    });

    const loginRequiredResponse = {
        content: [{
            type: 'text',
            text: `Authentication required. Please open the following URL in your browser to log in:\n\n${authUrl}\n\nOnce logged in, try again.`,
        }]
    };

    const withAuth = (handler) => async (args, extra) =>
        authenticationProvider.isAuthenticated() ? handler(args, extra) : loginRequiredResponse;

    server.registerTool(
        'list-hubs-projects',
        { description: 'Lists all hubs and their projects available to the authenticated user.' },
        withAuth(async () => {
            const hubs = await getHubsProjects(authenticationProvider);
            const text = hubs.flatMap(h => [
                `- Hub: ${h.name} (ID: ${h.id}, region: ${h.region})`,
                ...h.projects.map(p => `  - Project: ${p.name} (ID: ${p.id})`)
            ]).join('\n');
            return { content: [{ type: 'text', text }] };
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
            const text = items
                .filter(i => i.type === 'folders' || i.type === 'items')
                .map(i => i.type === 'folders'
                    ? `- Folder: ${i.name} (ID: ${i.id})`
                    : `- File: ${i.name} (ID: ${i.id}, Last modified at ${i.modifiedAt} by ${i.modifiedBy})`
                ).join('\n');
            return { content: [{ type: 'text', text }] };
        })
    );

    registerAppResource(server, 'viewer', VIEWER_RESOURCE_URI, {}, async () => ({
        contents: [{
            text: VIEWER_HTML,
            _meta: {
                ui: {
                    domain: publicUrl,
                    csp: {
                        resourceDomains: [...VIEWER_DOMAINS, 'blob:', 'data:'],
                        connectDomains: [...VIEWER_DOMAINS, 'wss://cdn.derivative.autodesk.com'],
                    },
                },
            },
        }]
    }));

    registerAppTool(server, 'preview-design', {
        description: 'Displays an interactive 3D preview of a design in APS Viewer. Use this when the user wants to visualise, inspect, or explore a design file.',
        inputSchema: z.object({
            projectId: z.string().describe('Project ID the design belongs to.'),
            designId: z.string().describe('Item ID of the design to preview.'),
            region: z.string().optional().describe('Hub region (e.g. "US", "EMEA"). Defaults to "US".'),
        }),
        annotations: { readOnlyHint: true },
        _meta: {
            ui: { resourceUri: VIEWER_RESOURCE_URI },
        },
    }, withAuth(async ({ projectId, designId, region = 'US' }) => {
        const [accessToken, tip] = await Promise.all([
            authenticationProvider.getAccessToken(),
            getItemTip(projectId, designId, authenticationProvider),
        ]);
        const config = {
            accessToken,
            env: 'AutodeskProduction2',
            api: region === 'US' ? 'streamingV2' : `streamingV2_${region}`,
        };
        return {
            structuredContent: { name: tip.name, urn: tip.derivativeUrn, config },
            content: [{ type: 'text', text: `Here is the preview of ${tip.name}.` }],
        };
    }));

    return server;
}
