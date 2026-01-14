
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

// פונקציית עזר לניקוי והדפסה בטוחה של מפתחות לדיבאג
const debugKey = (key) => {
  if (!key) return "MISSING";
  const s = key.toString().trim();
  if (s.length < 8) return `Too Short (${s.length})`;
  return `${s.substring(0, 4)}...${s.substring(s.length - 4)} (Len: ${s.length})`;
};

const platformHandlers = {
  google: async (creds, body) => {
    const { action, accountId, campaignId, status: newStatus, loginCustomerId } = body;
    
    // ניקוי רווחים מכל השדות
    const cleanAccountId = accountId.toString().trim().replace(/-/g, '');
    const cleanLoginId = loginCustomerId ? loginCustomerId.toString().trim().replace(/-/g, '') : undefined;
    const cleanDevToken = creds.developerToken.trim();
    const cleanRToken = creds.refreshToken.trim();
    const cleanCId = (creds.clientId || process.env.GOOGLE_CLIENT_ID || "").trim();
    const cleanCSecret = (creds.clientSecret || process.env.GOOGLE_CLIENT_SECRET || "").trim();

    console.log(`[Google Ads] Diagnostic Check:`);
    console.log(`- Action: ${action}`);
    console.log(`- Account ID: ${cleanAccountId}`);
    console.log(`- Login CID (MCC): ${cleanLoginId || 'None'}`);
    console.log(`- Client ID: ${debugKey(cleanCId)}`);
    console.log(`- Client Secret: ${debugKey(cleanCSecret)}`);
    console.log(`- Refresh Token: ${debugKey(cleanRToken)}`);

    if (!cleanCId || !cleanCSecret) {
      throw new Error("Missing Client ID or Client Secret");
    }

    try {
      const client = new GoogleAdsApi({
        client_id: cleanCId,
        client_secret: cleanCSecret,
        developer_token: cleanDevToken,
      });

      const customer = client.Customer({
        customer_id: cleanAccountId,
        refresh_token: cleanRToken,
        login_customer_id: cleanLoginId,
      });

      if (action === 'fetch') {
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
      }
      
      if (action === 'status') {
        const cleanCampaignId = campaignId.replace('live-', '');
        await customer.campaigns.update([{
          resource_name: `customers/${cleanAccountId}/campaigns/${cleanCampaignId}`,
          status: newStatus === 'Active' ? enums.CampaignStatus.ENABLED : enums.CampaignStatus.PAUSED
        }]);
        return { success: true };
      }
    } catch (err) {
      console.error("!!! [Google API Error]:", err.message);
      if (err.message.includes('invalid_client')) {
        console.error("אבחון: ה-Client ID או ה-Secret לא תואמים ל-Refresh Token. וודא שייצרת את ה-Refresh Token בעזרת אותו Client ID בדיוק.");
      }
      throw err;
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
    res.status(500).json({ 
      error: "API Request Failed", 
      message: error.message
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Upstep PPC Server is Live on port ${PORT}`);
});
