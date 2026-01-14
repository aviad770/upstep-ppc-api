
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { GoogleAdsApi, enums } = require('google-ads-api');
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
    const { action, accountId, campaignId, status: newStatus, loginCustomerId } = body;
    
    console.log(`[Google Ads] Action: ${action} | Account: ${accountId} | LoginCID: ${loginCustomerId || 'None'}`);

    const finalClientId = creds.clientId || process.env.GOOGLE_CLIENT_ID;
    const finalClientSecret = creds.clientSecret || process.env.GOOGLE_CLIENT_SECRET;

    if (!finalClientId || !finalClientSecret || !creds.developerToken || !creds.refreshToken) {
      throw new Error("Missing required credentials (ClientID, Secret, DevToken, or RefreshToken)");
    }

    // יצירת הקליינט עם תמיכה ב-Login Customer ID (קריטי לחשבונות MCC)
    const client = new GoogleAdsApi({
      client_id: finalClientId,
      client_secret: finalClientSecret,
      developer_token: creds.developerToken,
    });

    const customer = client.Customer({
      customer_id: accountId.replace(/-/g, ''),
      refresh_token: creds.refreshToken,
      login_customer_id: loginCustomerId ? loginCustomerId.replace(/-/g, '') : undefined,
    });

    if (action === 'fetch') {
      try {
        // שימוש ב-Query במקום ב-Report לשיפור היציבות
        const campaigns = await customer.query(`
          SELECT 
            campaign.id, 
            campaign.name, 
            campaign.status, 
            metrics.cost_micros, 
            metrics.conversions, 
            metrics.conversions_value,
            metrics.clicks,
            metrics.impressions,
            metrics.ctr
          FROM campaign 
          WHERE campaign.status IN ('ENABLED', 'PAUSED')
          LIMIT 100
        `);

        return campaigns.map(c => ({
          id: `live-${c.campaign.id}`,
          name: c.campaign.name,
          platform: 'Google',
          status: c.campaign.status === enums.CampaignStatus.ENABLED ? 'Active' : 'Paused',
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
        console.error("Google Ads Query Error:", err.message);
        throw err;
      }
    }
    
    if (action === 'status') {
      const cleanCampaignId = campaignId.replace('live-', '');
      await customer.campaigns.update([{
        resource_name: `customers/${accountId.replace(/-/g, '')}/campaigns/${cleanCampaignId}`,
        status: newStatus === 'Active' ? enums.CampaignStatus.ENABLED : enums.CampaignStatus.PAUSED
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
      error: "API Request Failed", 
      message: error.message
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Upstep PPC Server is Live on port ${PORT}`);
});
