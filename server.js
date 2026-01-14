
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { GoogleAdsApi } = require('google-ads-api');
require('dotenv').config();

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors()); 
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get('/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

const platformHandlers = {
  google: async (creds, body) => {
    const { action, accountId, campaignId, status: newStatus } = body;
    
    // לוגים לדיבאג (אל דאגה, אנחנו לא מדפיסים את המפתחות המלאים)
    console.log(`[Google Ads] Action: ${action} | Account: ${accountId}`);
    console.log(`[Auth Check] DeveloperToken: ${!!creds.developerToken}, RefreshToken: ${!!creds.refreshToken}, ClientID: ${!!creds.clientId}, ClientSecret: ${!!creds.clientSecret}`);

    const finalClientId = creds.clientId || process.env.GOOGLE_CLIENT_ID;
    const finalClientSecret = creds.clientSecret || process.env.GOOGLE_CLIENT_SECRET;

    if (!finalClientId || !finalClientSecret) {
      throw new Error("Missing Client ID or Client Secret. Please add them in Settings or Render Environment Variables.");
    }

    if (!creds.developerToken || !creds.refreshToken) {
      throw new Error("Missing Developer Token or Refresh Token.");
    }

    const client = new GoogleAdsApi({
      client_id: finalClientId,
      client_secret: finalClientSecret,
      developer_token: creds.developerToken,
    });

    const customer = client.Customer({
      customer_id: accountId.replace(/-/g, ''),
      refresh_token: creds.refreshToken,
    });

    if (action === 'fetch') {
      try {
        const campaigns = await customer.report({
          entity: 'campaign',
          attributes: [
            'campaign.id', 'campaign.name', 'campaign.status',
            'metrics.cost_micros', 'metrics.conversions', 'metrics.conversions_value',
            'metrics.clicks', 'metrics.impressions', 'metrics.ctr'
          ],
          constraints: [{ 'campaign.status': ['ENABLED', 'PAUSED'] }],
          limit: 100
        });

        return campaigns.map(c => ({
          id: `live-${c.campaign.id}`,
          name: c.campaign.name,
          platform: 'Google',
          status: c.campaign.status === 'ENABLED' ? 'Active' : 'Paused',
          spend: (c.metrics.cost_micros || 0) / 1000000,
          revenue: c.metrics.conversions_value || 0,
          clicks: c.metrics.clicks || 0,
          conversions: c.metrics.conversions || 0,
          impressions: c.metrics.impressions || 0,
          ctr: (c.metrics.ctr || 0) * 100,
          roas: c.metrics.cost_micros > 0 ? c.metrics.conversions_value / (c.metrics.cost_micros / 1000000) : 0,
          updatedAt: new Date().toISOString(),
        }));
      } catch (err) {
        console.error("Google Ads API Error Details:", JSON.stringify(err));
        throw err;
      }
    }
    
    if (action === 'status') {
      const cleanCampaignId = campaignId.replace('live-', '');
      await customer.campaigns.update([{
        resource_name: `customers/${accountId.replace(/-/g, '')}/campaigns/${cleanCampaignId}`,
        status: newStatus === 'Active' ? 'ENABLED' : 'PAUSED'
      }]);
      return { success: true };
    }

    return { success: false };
  }
};

app.post('/api/proxy/:platform/:action', async (req, res) => {
  const { platform, action } = req.params;
  const { creds } = req.body;

  const handler = platformHandlers[platform.toLowerCase()];
  if (!handler) return res.status(404).json({ error: 'Platform not supported' });

  try {
    const result = await handler(creds, { ...req.body, action });
    res.json(result);
  } catch (error) {
    console.error(`!!! [Proxy Error] ${platform}:`, error.message);
    res.status(500).json({ 
      error: "Google Ads Authentication Failed", 
      message: error.message,
      suggestion: "Check your Client ID, Client Secret, and Refresh Token in Settings."
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Upstep PPC Server is Live on port ${PORT}`);
});
