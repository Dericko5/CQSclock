// auth.js
const { ConfidentialClientApplication } = require('@azure/msal-node');
const { Client } = require('@microsoft/microsoft-graph-client');
require('isomorphic-fetch');

const msal = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}`,
    clientSecret: process.env.AZURE_CLIENT_SECRET,
  },
});

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken; // 1-min buffer
  const { accessToken, expiresOn } = await msal.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  });
  cachedToken = accessToken;
  tokenExpiry = expiresOn?.getTime?.() || Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

async function graphClient() {
  const token = await getAccessToken();
  return Client.init({
    authProvider: (done) => done(null, token),
  });
}

module.exports = { graphClient };
