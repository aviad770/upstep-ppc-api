
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

/**
 * מנגנון חילוץ שגיאות אגרסיבי עבור Google Ads API
 */
const getGoogleError = (error) => {
  if (!error) return "Unknown error occurred";
  
  // הדפסה מפורטת ללוגים של Render (תבדוק אותם ב-Dashboard של Render!)
  console.error("--- GOOGLE API ERROR DETECTED ---");
  
  // 1. מבנה שגיאה קלאסי של ספריית google-ads-api
  if (error.errors && Array.isArray(error.errors) && error.errors.length > 0) {
    const firstError = error.errors[0];
    console.error("Detailed Google Error:", JSON.stringify(firstError, null, 2));
    
    // ניסיון לחלץ את הקוד הספציפי (למשל DEVELOPER_TOKEN_NOT_APPROVED)
    const errorCode = firstError.errorCode ? Object.keys(firstError.errorCode)[0] : null;
    const trigger = firstError.trigger ? ` (Trigger: ${firstError.trigger})` : "";
    
    return firstError.message + (errorCode ? ` [Code: ${errorCode}]` : "") + trigger;
  }

  // 2. שגיאת Axios/HTTP (נפוץ ב-Auth)
  if (error.response && error.response.data) {
    console.error("HTTP Response Error Data:", JSON.stringify(error.response.data, null, 2));
    const data = error.response.data;
    if (data.error_description) return data.error_description;
    if (data.error && data.error.message) return data.error.message;
    if (typeof data.error === 'string') return data.error;
  }

  // 3. שגיאת gRPC פנימית
  if (error.details) return error.details;

  // 4. הודעה כללית
  console.error("Fallback error message:", error.message);
  return error.message || "An unexpected error occurred without a specific message from Google.";
};

app.post('/api/proxy/:platform/:action', async (req, res) => {
  const { platform, action } = req.params;
  const { creds, accountId, loginCustomerId, campaignId, status: newStatus } = req.body;

  if (platform.toLowerCase() !== 'google') {
    return res.status(404).json({ error: true, message: 'Platform not supported' });
  }

  try {
    if (!creds || !creds.developerToken || !creds.refreshToken || !creds.clientId || !creds.clientSecret) {
      return res.status(400).json({ error: true, message: "Missing Google Credentials in request body." });
    }

    const cleanAccountId = accountId ? accountId.toString().replace(/-/g, '').trim() : '';
    const cleanLoginId = (loginCustomerId && loginCustomerId.trim() !== "" && loginCustomerId.toLowerCase() !== 'none') 
      ? loginCustomerId.toString().replace(/-/g, '').trim() 
      : undefined;

    const client = new GoogleAdsApi({
      client_id: creds.clientId.trim(),
      client_secret: creds.clientSecret.trim(),
      developer_token: creds.developerToken.trim(),
    });

    const customer = client.Customer({
      customer_id: cleanAccountId,
      refresh_token: creds.refreshToken.trim(),
      login_customer_id: cleanLoginId,
    });

    if (action === 'test') {
      try {
        await customer.query(`SELECT campaign.id FROM campaign LIMIT 1`);
        return res.json({ success: true, message: "החיבור תקין!" });
      } catch (authError) {
        const msg = getGoogleError(authError);
        return res.status(401).json({ error: true, message: msg });
      }
    }

    if (action === 'fetch') {
      try {
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

        return res.json(campaigns.map(c => ({
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
          roas: (c.metrics.cost_micros > 0) ? c.metrics.conversions_value / (c.metrics.cost_micros / 1000000) : 0,
          updatedAt: new Date().toISOString(),
        })));
      } catch (fetchError) {
        return res.status(500).json({ error: true, message: getGoogleError(fetchError) });
      }
    }

    if (action === 'status') {
      const cleanCampaignId = campaignId.replace('live-', '');
      await customer.campaigns.update([{
        resource_name: `customers/${cleanAccountId}/campaigns/${cleanCampaignId}`,
        status: newStatus === 'Active' ? enums.CampaignStatus.ENABLED : enums.CampaignStatus.PAUSED
      }]);
      return res.json({ success: true });
    }

    res.status(400).json({ error: true, message: 'Invalid action' });

  } catch (error) {
    const errorMsg = getGoogleError(error);
    res.status(500).json({ error: true, message: errorMsg });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
