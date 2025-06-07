// This is the backend server that will run on Vercel.
// It acts as a secure proxy to fetch data from the Myenergi and Fox ESS APIs.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const { addDigest } = require("axios-digest");

// Initialize the express app
const app = express();

// Use CORS to allow requests from our frontend dashboard
app.use(cors());

// --- Myenergi Eddi API Endpoint ---
app.get('/api/myenergi', async (req, res) => {
  // Get credentials from Vercel's secure environment variables
  const username = process.env.MYENERGI_EDDI_SN;
  const password = process.env.MYENERGI_API_KEY;

  if (!username || !password) {
    return res.status(500).json({ error: 'Myenergi credentials are not configured on the server.' });
  }

  // Myenergi uses a specific server, often s18 for newer devices.
  const myenergiUrl = 'https://s18.myenergi.net/cgi-jstatus-E';
  
  // Use axios-digest to handle the specific 'Digest' authentication Myenergi requires
  const digestAxios = addDigest(axios);

  try {
    const response = await digestAxios.get(myenergiUrl, {
      auth: { username, password }
    });
    
    // Find the Eddi data in the response array
    const eddiData = response.data.eddi[0];
    if (!eddiData) {
        return res.status(404).json({ error: 'Eddi data not found in API response.' });
    }

    // Send back just the data we need for the dashboard
    res.status(200).json({
      diversion_kw: (eddiData.div / 1000).toFixed(2), // Convert from Watts to kW
      status: eddiData.stat
    });

  } catch (error) {
    console.error("Myenergi API Error:", error.message);
    res.status(500).json({ error: `Failed to fetch from Myenergi API. Status: ${error.response?.status}` });
  }
});

// --- Fox ESS API Endpoint ---
app.get('/api/foxess', async (req, res) => {
    // Get credentials from Vercel's secure environment variables
    const token = process.env.FOX_ESS_API_KEY;
    const inverterSn = process.env.FOX_ESS_INVERTER_SN; // We'll need to add this to Vercel

    if (!token || !inverterSn) {
        return res.status(500).json({ error: 'Fox ESS credentials are not configured on the server.' });
    }
    
    const foxUrl = 'https://www.foxesscloud.com/c/v0/device/real';
    const timestamp = new Date().getTime();
    const signatureString = `/c/v0/device/real\r\n${token}\r\n${timestamp}`;
    const signature = crypto.createHash('md5').update(signatureString).digest('hex');

    try {
        const response = await axios.post(foxUrl, 
            { sn: inverterSn }, 
            {
                headers: {
                    'token': token,
                    'timestamp': timestamp,
                    'signature': signature,
                    'lang': 'en',
                    'Content-Type': 'application/json'
                }
            }
        );

        const data = response.data.result;
        if (!data) {
             return res.status(404).json({ error: 'Fox ESS data not found in API response.' });
        }

        // Send back the data needed for the dashboard
        res.status(200).json({
            solar_kw: (data.pvPower / 1000).toFixed(2),
            battery_percent: data.soc,
            grid_kw: (data.gridPower / 1000).toFixed(2), // Negative is export, positive is import
        });

    } catch (error) {
        console.error("Fox ESS API Error:", error.message);
        res.status(500).json({ error: `Failed to fetch from Fox ESS API. Status: ${error.response?.status}` });
    }
});


// Export the app to be used by Vercel's serverless environment
module.exports = app;
