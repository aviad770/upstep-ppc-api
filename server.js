const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();

const app = express();

// אבטחה והגדרות בסיסיות
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors()); 
app.use(express.json());

const PORT = process.env.PORT || 3001;

// בדיקת תקינות - כדי שנדע שהשרת באוויר
app.get('/', (req, res) => {
  res.send('🚀 Upstep PPC API is Online!');
});

app.get('/health', (req, res) => {
  res.json({ status: 'online', timestamp: new Date().toISOString() });
});

// לוגיקה זמנית למשיכת נתונים (תתעדכן בהמשך עם API אמיתי)
const platformHandlers = {
  google: async (creds, body) => {
    return { success: true, platform: 'google', message: 'Connected' };
  },
  meta: async (creds, body) => {
    return { success: true, platform: 'meta', message: 'Connected' };
  }
};

// הניתוב הראשי שהאפליקציה פונה אליו
app.post('/api/proxy/:platform/:action', async (req, res) => {
  const { platform, action } = req.params;
  const handler = platformHandlers[platform.toLowerCase()];
  
  if (!handler) {
    return res.status(404).json({ error: `Platform ${platform} not supported.` });
  }

  try {
    const result = await handler(req.body.creds, { ...req.body, action });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
