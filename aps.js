import { AuthenticationClient, Scopes } from '@aps_sdk/authentication';
import { DataManagementClient } from '@aps_sdk/data-management';

const SCOPES = [Scopes.DataRead];

export class AppAuthenticationProvider {
    constructor(clientId, clientSecret) {
        this.authClient = new AuthenticationClient();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.cache = {
            accessToken: null,
            expiresAt: 0,
        };
    }

    async getAccessToken() {
        if (this.cache.expiresAt > Date.now()) {
            return this.cache.accessToken;
        }
        const credentials = await this.authClient.getTwoLeggedToken(this.clientId, this.clientSecret, SCOPES);
        this.cache.accessToken = credentials.access_token;
        this.cache.expiresAt = Date.now() + credentials.expires_in * 1000;
        return this.cache.accessToken;
    }
}

export async function getHubsProjects(authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const response = await client.getHubs();
    const hubs = response.data || [];
    const results = [];
    for (const hub of hubs) {
        const response = await client.getHubProjects(hub.id);
        const projects = response.data || [];
        results.push({
            id: hub.id,
            name: hub.attributes.name,
            region: hub.attributes.region,
            projects: projects.map(p => ({ id: p.id, name: p.attributes.name }))
        });
    }
    return results;
}

export async function getFolderContents(hubId, projectId, folderId, authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const response = folderId
        ? await client.getFolderContents(projectId, folderId)
        : await client.getProjectTopFolders(hubId, projectId);
    const items = response.data || [];
    return items.map(item => ({
        type: item.type,
        id: item.id,
        name: item.attributes.displayName,
        modifiedAt: item.attributes.lastModifiedTime,
        modifiedBy: item.attributes.lastModifiedUserName
    }));
}

export async function getItemTip(projectId, itemId, authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const response = await client.getItemTip(projectId, itemId);
    return {
        name: response.data.attributes.displayName,
        derivativeUrn: response.data.relationships.derivatives.data.id
    };
}
