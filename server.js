
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
 * מנגנון חילוץ שגיאות מתקדם - סורק את כל חלקי השגיאה של גוגל
 */
const getGoogleError = (error) => {
  if (!error) return "שגיאה לא ידועה";
  
  const message = error.message || "";
  const details = error.details || "";
  const innerError = (error.response && error.response.data) ? JSON.stringify(error.response.data) : "";
  
  // בניית מחרוזת אחת גדולה לסריקה
  const fullContext = (message + " " + details + " " + innerError + " " + JSON.stringify(error)).toLowerCase();

  console.error("--- GOOGLE API ERROR DETECTED ---");
  console.error("Raw Error Context:", fullContext);

  if (fullContext.includes('invalid_client')) {
    return "שגיאת Client ID/Secret: גוגל לא מזהה את ה-Client ID או ה-Secret. וודא שהעתקת אותם במדויק מ-Google Cloud Console ללא רווחים ושהם שייכים לאותו פרויקט.";
  }
  
  if (fullContext.includes('invalid_grant')) {
    return "שגיאת Refresh Token: הטוקן פג תוקף או שאינו תקין. יש להנפיק Refresh Token חדש ב-OAuth Playground.";
  }

  if (fullContext.includes('developer_token_not_approved')) {
    return "ה-Developer Token אינו מאושר. השתמש בטוקן מאושר או עבוד מול חשבון Test Ads.";
  }

  if (error.errors && error.errors[0]) return error.errors[0].message;
  
  return message || "חלה שגיאה בתקשורת מול גוגל. בדוק את פרטי החיבור.";
};

app.post('/api/proxy/:platform/:action', async (req, res) => {
  const { platform, action } = req.params;
  const { creds, accountId, loginCustomerId, campaignId, status: newStatus } = req.body;

  if (platform.toLowerCase() !== 'google') {
    return res.status(404).json({ error: true, message: 'Platform not supported' });
  }

  try {
    if (!creds) return res.status(400).json({ error: true, message: "Missing credentials" });

    const config = {
      client_id: (creds.clientId || "").trim(),
      client_secret: (creds.clientSecret || "").trim(),
      developer_token: (creds.developerToken || "").trim(),
    };

    const cleanAccountId = accountId ? accountId.toString().replace(/-/g, '').trim() : '';
    const cleanRefreshToken = (creds.refreshToken || "").trim();
    const cleanLoginId = (loginCustomerId && loginCustomerId.trim() !== "" && loginCustomerId.toLowerCase() !== 'none') 
      ? loginCustomerId.toString().replace(/-/g, '').trim() 
      : undefined;

    const client = new GoogleAdsApi(config);
    const customer = client.Customer({
      customer_id: cleanAccountId,
      refresh_token: cleanRefreshToken,
      login_customer_id: cleanLoginId,
    });

    if (action === 'test') {
      try {
        // ניסיון שליפת שם חשבון כדי לאמת את כל המפתחות
        await customer.query(`SELECT customer.descriptive_name FROM customer LIMIT 1`);
        return res.json({ success: true, message: "החיבור תקין ואומת בהצלחה!" });
      } catch (authError) {
        // החזרת 401 היא קריטית כדי שהדפדפן יציג את ה-JSON שלנו ולא שגיאת מערכת
        return res.status(401).json({ error: true, message: getGoogleError(authError) });
      }
    }

    if (action === 'fetch') {
      try {
        const campaigns = await customer.query(`
          SELECT campaign.id, campaign.name, campaign.status, metrics.cost_micros, metrics.conversions, metrics.conversions_value, metrics.clicks, metrics.impressions, metrics.ctr
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
        return res.status(401).json({ error: true, message: getGoogleError(fetchError) });
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
    res.status(500).json({ error: true, message: getGoogleError(error) });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
