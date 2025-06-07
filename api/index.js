// This is the backend server that will run on Vercel.
// It acts as a secure proxy to fetch data from the Fox ESS API.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
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
    
    const foxAPIPath = '/api/v1/device/realtime';
    const urlParams = new URLSearchParams({ sn: inverterSn }).toString();
    const fullAPIPathWithParams = `${foxAPIPath}?${urlParams}`;
    const foxUrl = `https://www.foxesscloud.com${fullAPIPathWithParams}`;
    
    const timestamp = new Date().getTime();
    const signatureString = `${fullAPIPathWithParams}\r\n${token}\r\n${timestamp}`;
    const signature = crypto.createHash('md5').update(signatureString).digest('hex');

    try {
        const response = await axios.get(foxUrl, {
            headers: {
                'token': token,
                'timestamp': timestamp,
                'signature': signature,
                'lang': 'en',
                'Content-Type': 'application/json'
            }
        });

        // ** DIAGNOSTIC LOGGING: This will show us the exact response from the server **
        console.log("Full Fox ESS Response Body:", JSON.stringify(response.data, null, 2));

        const result = response.data.result;
        if (!result) {
             return res.status(404).json({ error: 'Fox ESS data not found in API response.' });
        }
        
        const datas = result.datas || [];
        const pvPowerData = datas.find(d => d.variable === 'pvPower');
        const socData = datas.find(d => d.variable === 'SoC');
        const gridPowerData = datas.find(d => d.variable === 'gridPower');

        res.status(200).json({
            solar_kw: pvPowerData ? pvPowerData.value : 0,
            battery_percent: socData ? socData.value : 0,
            grid_kw: gridPowerData ? gridPowerData.value : 0,
        });

    } catch (error) {
        let errorMessage = error.message;
        if (error.response && error.response.data) {
            errorMessage = JSON.stringify(error.response.data);
        }
        console.error("Fox ESS API Error:", errorMessage);
        res.status(500).json({ error: `Fox ESS API request failed: ${errorMessage}` });
    }
});

// Export the app to be used by Vercel's serverless environment
module.exports = app;

