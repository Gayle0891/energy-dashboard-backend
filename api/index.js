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
    
    // ** THE FIX: Reverted to the original, correct API path for a POST request. **
    const foxAPIPath = '/api/v1/device/realtime';
    const foxUrl = `https://www.foxesscloud.com${foxAPIPath}`;
    
    const timestamp = new Date().getTime();
    // The signature for a POST request does not include the body or query params.
    const signatureString = `${foxAPIPath}\r\n${token}\r\n${timestamp}`;
    const signature = crypto.createHash('md5').update(signatureString).digest('hex');

    try {
        // ** THE FIX: Changed from axios.get back to axios.post **
        const response = await axios.post(foxUrl, 
            { "sn": inverterSn }, // The device serial number is sent in the request body.
            {
                headers: {
                    'token': token,
                    'timestamp': timestamp,
                    'signature': signature,
                    'lang': 'en',
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                }
            }
        );

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
            // Attempt to parse the error response data, but fall back to a string if it's not JSON
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


