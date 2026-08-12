import { AuthenticationClient, Scopes, ResponseType } from '@aps_sdk/authentication';
import { DataManagementClient } from '@aps_sdk/data-management';

const SCOPES = [Scopes.DataRead];

export class UserAuthenticationProvider {
    constructor(clientId, clientSecret, callbackUrl) {
        this.authClient = new AuthenticationClient();
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.callbackUrl = callbackUrl;
        this.credentials = null;
    }

    isAuthenticated() {
        return !!this.credentials;
    }

    getAuthorizationUrl(state) {
        return this.authClient.authorize(this.clientId, ResponseType.Code, this.callbackUrl, SCOPES, { state });
    }

    async completeLogin(code) {
        const credentials = await this.authClient.getThreeLeggedToken(this.clientId, code, this.callbackUrl, { clientSecret: this.clientSecret });
        this.credentials = {
            accessToken: credentials.access_token,
            refreshToken: credentials.refresh_token,
            expiresAt: Date.now() + credentials.expires_in * 1000
        };
    }

    async getAccessToken() {
        if (!this.isAuthenticated()) {
            throw new Error('Not authenticated');
        }
        if (this.credentials.expiresAt < Date.now()) {
            const credentials = await this.authClient.refreshToken(this.credentials.refreshToken, this.clientId, { clientSecret: this.clientSecret });
            this.credentials = {
                accessToken: credentials.access_token,
                refreshToken: credentials.refresh_token,
                expiresAt: Date.now() + credentials.expires_in * 1000
            };
        }
        return this.credentials.accessToken;
    }
}

export async function getHubsProjects(authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data: hubs = [] } = await client.getHubs();
    return Promise.all(hubs.map(async hub => {
        const { data: projects = [] } = await client.getHubProjects(hub.id);
        return {
            id: hub.id,
            name: hub.attributes.name,
            region: hub.attributes.region,
            projects: projects.map(p => ({ id: p.id, name: p.attributes.name }))
        };
    }));
}

export async function getFolderContents(hubId, projectId, folderId, authenticationProvider) {
    const client = new DataManagementClient({ authenticationProvider });
    const { data: items = [] } = folderId
        ? await client.getFolderContents(projectId, folderId)
        : await client.getProjectTopFolders(hubId, projectId);
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
    const { data } = await client.getItemTip(projectId, itemId);
    return {
        name: data.attributes.displayName,
        derivativeUrn: data.relationships.derivatives.data.id
    };
}
