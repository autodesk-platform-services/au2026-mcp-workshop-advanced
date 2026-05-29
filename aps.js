import { AuthenticationClient, ResponseType, Scopes } from '@aps_sdk/authentication';
import { DataManagementClient } from '@aps_sdk/data-management';

const SCOPES = [Scopes.DataRead];

export class UserAuthenticationProvider {
    constructor(clientId, clientSecret) {
        this.authClient = new AuthenticationClient();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.accessToken = null;
        this.refreshToken = null;
        this.expiresAt = 0;
    }

    isAuthenticated() {
        return this.accessToken !== null;
    }

    setTokens(accessToken, refreshToken, expiresIn) {
        this.accessToken = accessToken;
        this.refreshToken = refreshToken;
        this.expiresAt = Date.now() + expiresIn * 1000;
    }

    async getAccessToken() {
        if (this.accessToken && this.expiresAt > Date.now()) {
            return this.accessToken;
        }
        if (!this.refreshToken) {
            throw new Error('Not authenticated');
        }
        const credentials = await this.authClient.refreshToken(this.refreshToken, this.clientId, {
            clientSecret: this.clientSecret,
            scopes: SCOPES,
        });
        this.setTokens(credentials.access_token, credentials.refresh_token, credentials.expires_in);
        return this.accessToken;
    }
}

export function getAuthorizationUrl(clientId, callbackUrl, state) {
    const authClient = new AuthenticationClient();
    return authClient.authorize(clientId, ResponseType.Code, callbackUrl, SCOPES, { state });
}

export async function exchangeAuthCode(clientId, clientSecret, code, callbackUrl) {
    const authClient = new AuthenticationClient();
    return authClient.getThreeLeggedToken(clientId, code, callbackUrl, { clientSecret });
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
