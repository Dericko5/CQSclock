// middleware/onedrive.js - OneDrive integration (app-only, no /me)
const axios = require('axios');
const fs = require('fs');

class OneDriveService {
  constructor() {
    this.clientId = process.env.AZURE_CLIENT_ID;
    this.clientSecret = process.env.AZURE_CLIENT_SECRET;
    this.tenantId = process.env.AZURE_TENANT_ID;
    this.folderPath = process.env.ONEDRIVE_FOLDER_PATH || 'TimeClock_Photos';
    this.serviceUpn = process.env.ONEDRIVE_SERVICE_UPN; // e.g., uploader@yourtenant.com
    this.accessToken = null;
    this.tokenExpiry = null;
  }

  baseDriveRoot() {
    // All endpoints go under the service account's drive
    return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.serviceUpn)}/drive`;
  }

  // Get access token using client credentials flow
  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      return this.accessToken;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('client_id', this.clientId);
    params.append('client_secret', this.clientSecret);
    params.append('scope', 'https://graph.microsoft.com/.default');
    params.append('grant_type', 'client_credentials');

    const response = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    this.accessToken = response.data.access_token;
    this.tokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000; // minus 5 min
    return this.accessToken;
  }

  // Ensure a given path exists under the service account's OneDrive
  async ensurePathExists(targetPath) {
    const token = await this.getAccessToken();
    const rootBase = this.baseDriveRoot();

    // First, try to GET the whole path
    const url = `${rootBase}/root:/${targetPath}`;
    try {
      await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
      return; // exists
    } catch (err) {
      if (err.response?.status !== 404) throw err;
    }

    // Create each segment step-by-step
    const parts = targetPath.split('/').filter(Boolean);
    let current = '';

    for (const part of parts) {
      const parent = current;
      current = current ? `${current}/${part}` : part;

      try {
        await axios.get(`${rootBase}/root:/${current}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
      } catch (err) {
        if (err.response?.status === 404) {
          const createUrl = parent
            ? `${rootBase}/root:/${parent}:/children`
            : `${rootBase}/root/children`;

          await axios.post(createUrl, {
            name: part,
            folder: {},
            '@microsoft.graph.conflictBehavior': 'rename'
          }, {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          });
        } else {
          throw err;
        }
      }
    }
  }

  // Upload a file to OneDrive (≤ ~5 MB based on your MAX_FILE_SIZE)
  async uploadFile(filePath, fileName, userEmail) {
    const token = await this.getAccessToken();

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const sanitizedEmail = (userEmail || 'unknown').replace(/[^a-zA-Z0-9._@-]/g, '_');
    const uniqueFileName = `${timestamp}_${sanitizedEmail}_${fileName}`;

    // Put each user's photos inside a subfolder named by their email
    const finalFolder = `${this.folderPath}/${sanitizedEmail}`;
    await this.ensurePathExists(finalFolder);

    const fileStream = fs.createReadStream(filePath);
    const fileStats = fs.statSync(filePath);

    const uploadUrl = `${this.baseDriveRoot()}/root:/${finalFolder}/${uniqueFileName}:/content`;

    const response = await axios.put(uploadUrl, fileStream, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileStats.size
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    return {
      oneDriveId: response.data.id,
      oneDriveUrl: response.data.webUrl,
      fileName: uniqueFileName,
      size: response.data.size,
      uploadedAt: new Date().toISOString()
    };
  }

  async cleanupLocalFile(filePath) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
  }

  async getFileDownloadUrl(oneDriveId) {
    const token = await this.getAccessToken();
    const url = `${this.baseDriveRoot()}/items/${oneDriveId}`;
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    return res.data['@microsoft.graph.downloadUrl'];
  }

  async listFiles() {
    const token = await this.getAccessToken();
    const url = `${this.baseDriveRoot()}/root:/${this.folderPath}:/children`;
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    return res.data.value.map(f => ({
      id: f.id,
      name: f.name,
      size: f.size,
      createdDateTime: f.createdDateTime,
      webUrl: f.webUrl
    }));
  }
}

module.exports = OneDriveService;
