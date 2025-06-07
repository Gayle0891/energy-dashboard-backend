// This is the backend server that will run on Vercel.
// It acts as a secure proxy to fetch data from the Fox ESS API.

const express = require('express');
const cors = require('cors');
const axios =require('axios');
const crypto = require('crypto');

// Initialize the express app
const app = express();
app.use(cors()); // Allow requests from our frontend dashboard

// --- Myenergi Eddi API Endpoint ---
// The Myenergi endpoint is temporarily disabled to resolve server errors.
/*
app.get('/api/myenergi', async (req, res) => {
  // ... All Myenergi code is temporarily disabled here ...
});
*/

// --- Fox ESS API Endpoint ---
app.get('/api/foxess', async (req, res) => {
    const token = process.env.FOX_ESS_API_KEY;
    const inverterSn = process.env.FOX_ESS_INVERTER_SN;

    if (!token || !inverterSn) {
        return res.status(500).json({ error: 'Fox ESS credentials are not configured on the server.' });
    }
    
    // ** THE FIX: Using the official, documented API path. **
    const foxAPIPath = '/c/v0/device/real';
    const foxUrl = `https://www.foxesscloud.com${foxAPIPath}`;
    
    const timestamp = new Date().getTime();

    // ** THE FIX: The signature must exactly match the official API path. **
    const signatureString = `${foxAPIPath}\r\n${token}\r\n${timestamp}`;
    const signature = crypto.createHash('md5').update(signatureString).digest('hex');

    try {
        const response = await axios.post(foxUrl, 
            { "sn": inverterSn }, 
            {
                headers: {
                    'token': token,
                    'timestamp': timestamp,
                    'signature': signature,
                    'lang': 'en',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json',
                    // Adding a standard User-Agent header as a best practice.
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
                }
            }
        );
        
        // This is a new check. If the response contains a non-zero 'errno', it's an API-level error.
        if (response.data.errno !== 0) {
            console.error("Fox ESS API returned an error:", response.data);
            return res.status(400).json({ error: `Fox ESS API Error: ${response.data.msg || 'Unknown error'}` });
        }

        const result = response.data.result;
        if (!result) {
             return res.status(404).json({ error: 'Fox ESS data not found in API response.' });
        }
        
        // The data structure from this endpoint is different. We adapt to it here.
        const datas = result.datas || [];
        const pvPowerData = datas.find(d => d.key === 'pvPower');
        const socData = datas.find(d => d.key === 'SoC');
        const gridPowerData = datas.find(d => d.key === 'gridPower');

        res.status(200).json({
            solar_kw: pvPowerData ? (pvPowerData.value / 1000).toFixed(2) : 0, // Value is in Watts
            battery_percent: socData ? socData.value : 0,
            grid_kw: gridPowerData ? (gridPowerData.value / 1000).toFixed(2) : 0, // Value is in Watts
        });

    } catch (error) {
        let errorMessage = error.message;
        if (error.response && error.response.data) {
            try {
                 errorMessage = JSON.stringify(error.response.data);
            } catch (e) {
                 errorMessage = error.response.data;
            }
        }
        console.error("Fox ESS API Error:", errorMessage);
        res.status(500).json({ error: `Fox ESS API request failed: ${errorMessage}` });
    }
});

// Export the app to be used by Vercel's serverless environment
module.exports = app;
