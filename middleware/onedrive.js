// middleware/onedrive.js — OneDrive integration w/ nested subpaths + shortcut support
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');

class OneDriveService {
  constructor(opts = {}) {
    this.clientId     = process.env.AZURE_CLIENT_ID;
    this.clientSecret = process.env.AZURE_CLIENT_SECRET;
    this.tenantId     = process.env.AZURE_TENANT_ID;

    // Base folder inside the target drive (can be a real folder or a shortcut at root)
    this.folderPath   = (opts.folderPath || process.env.ONEDRIVE_FOLDER_PATH || 'TimeClock_Photos');

    // App runs as this account, but targets this user's drive/library
    this.serviceUpn   = process.env.ONEDRIVE_SERVICE_UPN;
    this.targetUpn    = process.env.ONEDRIVE_TARGET_UPN || this.serviceUpn;

    // Optional: pin a specific drive
    this.driveId      = process.env.ONEDRIVE_DRIVE_ID || null;

    // If base is a shortcut, we resolve to the target drive + root item id
    this.rootItemId   = null;

    this.accessToken  = null;
    this.tokenExpiry  = null;
  }

  // Base REST root: a specific drive (if pinned) or the target user's default drive
  baseDriveRoot() {
    return this.driveId
      ? `https://graph.microsoft.com/v1.0/drives/${this.driveId}`
      : `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(this.targetUpn)}/drive`;
  }

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

    const resp = await axios.post(tokenUrl, params, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    this.accessToken = resp.data.access_token;
    this.tokenExpiry = Date.now() + (resp.data.expires_in - 300) * 1000;
    return this.accessToken;
  }

  // If base folder is a shortcut, switch to the remote drive + item id
  async resolveBaseFolderIfNeeded() {
    if (this.rootItemId) return;
    const token = await this.getAccessToken();
    const root  = this.baseDriveRoot();

    try {
      const url = `${root}/root:/${this.folderPath}`;
      const { data } = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });

      if (data.remoteItem?.id && data.remoteItem?.parentReference?.driveId) {
        // Shortcut → pin the remote drive + item
        this.driveId    = data.remoteItem.parentReference.driveId;
        this.rootItemId = data.remoteItem.id;
        console.log(`🔗 Base is a shortcut → driveId=${this.driveId}, itemId=${this.rootItemId}`);
      } else {
        // Real folder in this drive
        this.driveId    = this.driveId || data.parentReference?.driveId || null;
        this.rootItemId = data.id;
        console.log(`📁 Base is local in drive → itemId=${this.rootItemId}`);
      }
    } catch (e) {
      console.error('resolveBaseFolderIfNeeded error:', e?.response?.status, e?.response?.data || e.message);
      throw e;
    }
  }

  // Sanitize a single segment (NOT the whole path)
  sanitizeSegment(s) {
    return String(s || '')
      .replace(/[\\/:*?"<>|]/g, '')    // remove illegal path chars
      .replace(/\s+/g, ' ')            // collapse whitespace
      .trim();
  }

  // Ensure a full path exists under the base folder.
  // targetPath is absolute under the drive root (e.g., "TimeClock_Photos/Companies/…")
  async ensurePathExists(targetPath) {
    await this.resolveBaseFolderIfNeeded();
    const token = await this.getAccessToken();
    const root  = this.baseDriveRoot();

    const safePath = targetPath
      .split('/')
      .filter(Boolean)
      .map(seg => this.sanitizeSegment(seg))
      .join('/');

    // If our base resolved to a shortcut root item, walk children under items/{rootItemId}
    if (this.rootItemId) {
      // Compute relative segments under the base folder
      const rel = safePath.replace(new RegExp(`^${this.folderPath}/?`, 'i'), '');
      const segments = rel.split('/').filter(Boolean);
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

    // Otherwise, create from drive root using root:/path endpoints
    // Walk each segment so we can create progressively
    const parts = safePath.split('/').filter(Boolean);
    let curr = '';
    for (const part of parts) {
      const next = curr ? `${curr}/${part}` : part;
      try {
        await axios.get(`${root}/root:/${next}`, { headers: { Authorization: `Bearer ${token}` } });
      } catch (err) {
        if (err.response?.status === 404) {
          const createUrl = curr ? `${root}/root:/${curr}:/children` : `${root}/root/children`;
          await axios.post(createUrl, { name: part, folder: {}, '@microsoft.graph.conflictBehavior': 'replace' }, {
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
          });
        } else {
          throw err;
        }
      }
      curr = next;
    }
  }

  // Upload a file under base + subPath (subPath can contain multiple segments)
  async uploadFile(filePath, fileName, subPath = '') {
    await this.resolveBaseFolderIfNeeded();
    const token = await this.getAccessToken();
    const base  = this.baseDriveRoot();

    // Sanitize file name but keep real extension
    const rawName  = String(fileName || 'upload.bin').replace(/[\\/:*?"<>|]/g, '').trim();
    const ext      = path.extname(rawName);
    const baseName = ext ? rawName.slice(0, -ext.length) : rawName;

    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const rand = Math.random().toString(36).slice(2, 8);
    const finalName = `${baseName}_${ts}_${rand}${ext || ''}`;

    // Build the full destination folder: base folder + subPath (multi-segment)
    const safeSubPath = String(subPath || '')
      .split('/')
      .filter(Boolean)
      .map(seg => this.sanitizeSegment(seg))
      .join('/');
    const finalFolder = safeSubPath
      ? `${this.folderPath}/${safeSubPath}`
      : this.folderPath;

    // Make sure the path exists
    await this.ensurePathExists(finalFolder);

    // Read file bytes
    const stats = fs.statSync(filePath);
    const buffer = fs.readFileSync(filePath);
    const contentType = mime.lookup(finalName) || 'application/octet-stream';

    // Build a Graph path where EACH segment is encoded separately
    const encodePath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

    // Relative path beneath base (if base is a shortcut item)
    const relUnderBase = finalFolder.replace(new RegExp(`^${this.folderPath}/?`, 'i'), '');

    let uploadUrl;
    if (this.rootItemId) {
      const rel = relUnderBase ? `${encodePath(relUnderBase)}/${encodeURIComponent(finalName)}` : encodeURIComponent(finalName);
      uploadUrl = `${base}/items/${this.rootItemId}:/${rel}:/content?@microsoft.graph.conflictBehavior=replace`;
    } else {
      const full = `${encodePath(this.folderPath)}${relUnderBase ? '/' + encodePath(relUnderBase) : ''}/${encodeURIComponent(finalName)}`;
      uploadUrl = `${base}/root:/${full}:/content?@microsoft.graph.conflictBehavior=replace`;
    }

    // Helpful server log so you can find the file quickly
    console.log('📤 OneDrive upload →', {
      driveId: this.driveId || '(target user default)',
      baseFolder: this.folderPath,
      subPath: safeSubPath || '(none)',
      finalFolder,
      finalName
    });

    const resp = await axios.put(uploadUrl, buffer, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': stats.size
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    return {
      oneDriveId: resp.data.id,
      oneDriveUrl: resp.data.webUrl,
      fileName: finalName,
      size: resp.data.size,
      uploadedAt: new Date().toISOString()
    };
  }

  async cleanupLocalFile(filePath) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
  }

  async getFileDownloadUrl(oneDriveId) {
    await this.resolveBaseFolderIfNeeded();
    const token = await this.getAccessToken();
    const base  = this.baseDriveRoot();
    const url   = `${base}/items/${oneDriveId}`;
    const res   = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    return res.data['@microsoft.graph.downloadUrl'];
  }

  async listFiles() {
    await this.resolveBaseFolderIfNeeded();
    const token = await this.getAccessToken();
    const base  = this.baseDriveRoot();

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
