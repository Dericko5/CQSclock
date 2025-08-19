// middleware/onedrive.js - OneDrive integration with shortcut support + target user
const axios = require('axios');
const fs = require('fs');

class OneDriveService {
  constructor() {
    this.clientId = process.env.AZURE_CLIENT_ID;
    this.clientSecret = process.env.AZURE_CLIENT_SECRET;
    this.tenantId = process.env.AZURE_TENANT_ID;

    // Base folder (in the TARGET user's drive)
    this.folderPath = process.env.ONEDRIVE_FOLDER_PATH || 'TimeClock_Photos';

    // App runs as this account (for audit only; token is app-only)
    this.serviceUpn = process.env.ONEDRIVE_SERVICE_UPN;

    // NEW: the user whose OneDrive we actually write into (Angelica)
    this.targetUpn  = process.env.ONEDRIVE_TARGET_UPN || this.serviceUpn;

    // Optional: pin directly to a specific drive/folder (rock-solid)
    this.driveId    = process.env.ONEDRIVE_DRIVE_ID || null;
    this.rootItemId = process.env.ONEDRIVE_ROOT_ITEM_ID || null;

    this.accessToken = null;
    this.tokenExpiry = null;
  }

  // Use pinned drive if provided; otherwise use the TARGET user's drive (Angelica)
  baseDriveRoot() {
    return this.driveId
      ? `https://graph.microsoft.com/v1.0/drives/${this.driveId}`
      : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.targetUpn)}/drive`;
  }

  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) return this.accessToken;

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;
    const params = new URLSearchParams();
    params.append('client_id', this.clientId);
    params.append('client_secret', this.clientSecret);
    params.append('scope', 'https://graph.microsoft.com/.default');
    params.append('grant_type', 'client_credentials');

    const resp = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    this.accessToken = resp.data.access_token;
    this.tokenExpiry = Date.now() + (resp.data.expires_in - 300) * 1000;
    return this.accessToken;
  }

  // Resolve whether folderPath is a real folder or a shortcut; pin driveId/rootItemId
  async resolveBaseFolderIfNeeded() {
    if (this.rootItemId) return; // already pinned
    const token = await this.getAccessToken();
    const root = this.baseDriveRoot();

    try {
      const url = `${root}/root:/${this.folderPath}`;
      const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });

      if (data.remoteItem?.id && data.remoteItem?.parentReference?.driveId) {
        // It's a shortcut; switch to the real drive + item
        this.driveId = data.remoteItem.parentReference.driveId;
        this.rootItemId = data.remoteItem.id;
        console.log(`🔗 Resolved shortcut → driveId=${this.driveId}, itemId=${this.rootItemId}`);
      } else {
        // Real folder in the target user's drive
        this.driveId = this.driveId || data.parentReference?.driveId || null;
        this.rootItemId = data.id;
        console.log(`📁 Using folder in target drive → itemId=${this.rootItemId}`);
      }
    } catch (e) {
      console.error('resolveBaseFolderIfNeeded error:', e?.response?.status, e?.response?.data || e.message);
      throw e;
    }
  }

  // Ensure a path exists beneath the base folder
  async ensurePathExists(targetPath) {
    await this.resolveBaseFolderIfNeeded();
    const token = await this.getAccessToken();
    const root = this.baseDriveRoot();

    const relativePath = this.rootItemId
      ? targetPath.replace(new RegExp(`^${this.folderPath}/?`, 'i'), '')
      : targetPath;

    if (this.rootItemId) {
      const segments = relativePath.split('/').filter(Boolean);
      let currentId = this.rootItemId;

      for (const seg of segments) {
        try {
          const child = await axios.get(
            `${root}/items/${currentId}:/${encodeURIComponent(seg)}`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          currentId = child.data.id;
        } catch (err) {
          if (err.response?.status === 404) {
            const created = await axios.post(
              `${root}/items/${currentId}/children`,
              { name: seg, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' },
              { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
            );
            currentId = created.data.id;
          } else {
            throw err;
          }
        }
      }
      return;
    }

    // Fallback: absolute create from drive root
    try {
      await axios.get(`${root}/root:/${targetPath}`, { headers: { Authorization: `Bearer ${token}` } });
      return;
    } catch (err) {
      if (err.response?.status !== 404) throw err;
    }

    const parts = targetPath.split('/').filter(Boolean);
    let currentPath = '';
    for (const part of parts) {
      const parent = currentPath;
      currentPath = currentPath ? `${currentPath}/${part}` : part;

      try {
        await axios.get(`${root}/root:/${currentPath}`, { headers: { Authorization: `Bearer ${token}` } });
      } catch (err) {
        if (err.response?.status === 404) {
          const createUrl = parent ? `${root}/root:/${parent}:/children` : `${root}/root/children`;
          await axios.post(createUrl, { name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
          });
        } else {
          throw err;
        }
      }
    }
  }

  // Upload to base folder + subFolder (we pass location as subFolder)
  async uploadFile(filePath, fileName, subFolder) {
    await this.resolveBaseFolderIfNeeded();
    const token = await this.getAccessToken();

    const folderSegment = (subFolder || 'unknown').trim().replace(/[\\/:*?"<>|]/g, '_');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const uniqueFileName = `${timestamp}_${folderSegment}_${fileName}`;

    const finalFolder = `${this.folderPath}/${folderSegment}`;
    await this.ensurePathExists(finalFolder);

    const fileStream = fs.createReadStream(filePath);
    const fileStats = fs.statSync(filePath);

    const base = this.baseDriveRoot();
    const uploadUrl = this.rootItemId
      ? `${base}/items/${this.rootItemId}:/${folderSegment}/${uniqueFileName}:/content`
      : `${base}/root:/${finalFolder}/${uniqueFileName}:/content`;

    console.log('GRAPH PUT:', uploadUrl);
    const response = await axios.put(uploadUrl, fileStream, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': fileStats.size
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });
    console.log('GRAPH OK webUrl:', response.data.webUrl);

    return {
      oneDriveId: response.data.id,
      oneDriveUrl: response.data.webUrl,
      fileName: uniqueFileName,
      size: response.data.size,
      uploadedAt: new Date().toISOString()
    };
  }

  async cleanupLocalFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  }

  async getFileDownloadUrl(oneDriveId) {
    await this.resolveBaseFolderIfNeeded();
    const token = await this.getAccessToken();
    const base = this.baseDriveRoot();
    const url = `${base}/items/${oneDriveId}`;
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    return res.data['@microsoft.graph.downloadUrl'];
  }

  async listFiles() {
    await this.resolveBaseFolderIfNeeded();
    const token = await this.getAccessToken();
    const base = this.baseDriveRoot();

    const url = this.rootItemId
      ? `${base}/items/${this.rootItemId}/children`
      : `${base}/root:/${this.folderPath}:/children`;

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
