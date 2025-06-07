// This is the backend server that will run on Vercel.
// It acts as a secure proxy to fetch data from the Myenergi and Fox ESS APIs.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');
const DigestFetch = require('digest-fetch');

// Initialize the express app
const app = express();
app.use(cors()); // Allow requests from our frontend dashboard

// --- Myenergi Eddi API Endpoint ---
app.get('/api/myenergi', async (req, res) => {
  const username = process.env.MYENERGI_EDDI_SN;
  const password = process.env.MYENERGI_API_KEY;

  if (!username || !password) {
    return res.status(500).json({ error: 'Myenergi credentials are not configured on the server.' });
  }

  try {
    // Step 1: Get the correct server address from the Myenergi director service.
    const directorUrl = 'https://director.myenergi.net/cgi-jstatus-E';
    console.log(`[Myenergi] Step 1: Contacting Director at ${directorUrl}`);
    let serverAsn;

    // We tell axios to treat any status code as a success for this call,
    // so we can inspect the headers regardless of the response.
    const directorResponse = await axios.get(directorUrl, {
        validateStatus: () => true,
    });

    // **This is the critical fix:** We robustly check that the header exists and has a value.
    if (directorResponse && directorResponse.headers && typeof directorResponse.headers['x_myenergi-asn'] === 'string' && directorResponse.headers['x_myenergi-asn'].length > 0) {
        serverAsn = directorResponse.headers['x_myenergi-asn'];
    } else {
        // This is the failure point. If this header is missing, we cannot proceed.
        console.error("[Myenergi] Director Error: 'x_myenergi-asn' header was not found or was empty in the response.", directorResponse.headers);
        throw new Error('Failed to get server address (ASN) from Myenergi director.');
    }
    
    console.log(`[Myenergi] Step 2: Director assigned server: ${serverAsn}. Now authenticating...`);
    
    // Step 3: Use the digest-fetch library to authenticate with the *correct* server address.
    const client = new DigestFetch(username, password);
    const myenergiApiEndpoint = `https://${serverAsn}/cgi-jstatus-E`;

    const response = await client.fetch(myenergiApiEndpoint);
    
    // Check if the final response is OK
    if (!response.ok) {
        throw new Error(`Authentication failed with server ${serverAsn}. Status: ${response.status}`);
    }
    
    const data = await response.json();
    
    const eddiData = data.eddi[0];
    if (!eddiData) {
        return res.status(404).json({ error: 'Eddi data not found in API response.' });
    }
    
    res.status(200).json({
      diversion_kw: (eddiData.div / 1000).toFixed(2),
      status: eddiData.stat
    });

  } catch (error) {
    console.error("Myenergi API Full Error:", error.message);
    res.status(500).json({ error: `Myenergi request failed: ${error.message}` });
  }
});


// --- Fox ESS API Endpoint ---
app.get('/api/foxess', async (req, res) => {
    const token = process.env.FOX_ESS_API_KEY;
    const inverterSn = process.env.FOX_ESS_INVERTER_SN;

    if (!token || !inverterSn) {
        return res.status(500).json({ error: 'Fox ESS credentials are not configured on the server.' });
    }
    
    const foxAPIPath = '/api/v1/device/realtime';
    const foxUrl = `https://www.foxesscloud.com${foxAPIPath}`;
    
    const timestamp = new Date().getTime();
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
                    'Content-Type': 'application/json'
                }
            }
        );

        const result = response.data.result;
        if (!result) {
             return res.status(404).json({ error: 'Fox ESS data not found in API response (v1 endpoint).' });
        }
        
        const datas = result.datas || [];
        const pvPower = datas.find(d => d.variable === 'pvPower')?.value || 0;
        const soc = datas.find(d => d.variable === 'SoC')?.value || 0;
        const gridPower = datas.find(d => d.variable === 'gridPower')?.value || 0;

        res.status(200).json({
            solar_kw: (pvPower).toFixed(2),
            battery_percent: soc,
            grid_kw: (gridPower).toFixed(2),
        });

    } catch (error) {
        console.error("Fox ESS API Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: `Failed to fetch from Fox ESS API.` });
    }
});

// Export the app to be used by Vercel's serverless environment
module.exports = app;
