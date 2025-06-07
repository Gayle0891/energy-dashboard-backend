// This is the backend server that will run on Vercel.
// It acts as a secure proxy to fetch data from the Myenergi and Fox ESS APIs.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

// Initialize the express app
const app = express();
app.use(cors()); // Allow requests from our frontend dashboard

// --- Helper function for Myenergi's Digest Authentication ---
// This function manually handles the digest authentication process, making it more reliable.
const performMyenergiRequest = async (username, password) => {
    const myenergiUrl = 'https://s18.myenergi.net/cgi-jstatus-E';
    const method = 'GET';
    
    try {
        // Step 1: Make an initial request to get the authentication challenge (a 401 response)
        const initialResponse = await axios.get(myenergiUrl).catch(error => {
            if (error.response && error.response.status === 401) {
                return error.response; // This is the expected challenge
            }
            throw error; // Rethrow other errors
        });

        // Step 2: Parse the 'WWW-Authenticate' header from the 401 response to get auth parameters
        const authHeader = initialResponse.headers['www-authenticate'];
        const params = authHeader.split(/, | /).reduce((acc, part) => {
            const [key, value] = part.split(/=(.+)/);
            if (key) acc[key] = value.replace(/"/g, '');
            return acc;
        }, {});

        const { realm, qop, nonce, opaque } = params;

        // Step 3: Create the required cryptographic hashes for the digest response
        const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
        const ha2 = crypto.createHash('md5').update(`${method}:${myenergiUrl.replace('https://s18.myenergi.net', '')}`).digest('hex');
        const cnonce = crypto.randomBytes(8).toString('hex'); // Client nonce
        const nc = '00000001'; // Nonce count
        const responseHash = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');

        // Step 4: Construct the final 'Authorization' header
        const authDetails = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${myenergiUrl.replace('https://s18.myenergi.net', '')}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${responseHash}", opaque="${opaque}"`;

        // Step 5: Make the fully authenticated request
        return await axios.get(myenergiUrl, {
            headers: { 'Authorization': authDetails }
        });

    } catch (error) {
        // Rethrow a clear error to be caught by the main endpoint handler
        throw new Error(`Myenergi digest auth failed: ${error.message}`);
    }
};


// --- Myenergi Eddi API Endpoint ---
app.get('/api/myenergi', async (req, res) => {
  const username = process.env.MYENERGI_EDDI_SN;
  const password = process.env.MYENERGI_API_KEY;

  if (!username || !password) {
    return res.status(500).json({ error: 'Myenergi credentials are not configured on the server.' });
  }

  try {
    const response = await performMyenergiRequest(username, password);
    const eddiData = response.data.eddi[0];
    if (!eddiData) {
        return res.status(404).json({ error: 'Eddi data not found in API response.' });
    }
    // Send back the live data
    res.status(200).json({
      diversion_kw: (eddiData.div / 1000).toFixed(2),
      status: eddiData.stat
    });
  } catch (error) {
    console.error("Myenergi API Error:", error.message);
    res.status(500).json({ error: `Failed to fetch from Myenergi API.` });
  }
});

// --- Fox ESS API Endpoint ---
app.get('/api/foxess', async (req, res) => {
    const token = process.env.FOX_ESS_API_KEY;
    const inverterSn = process.env.FOX_ESS_INVERTER_SN;

    if (!token || !inverterSn) {
        return res.status(500).json({ error: 'Fox ESS credentials are not configured on the server.' });
    }
    
    const foxUrl = 'https://www.foxesscloud.com/c/v0/device/real';
    const timestamp = new Date().getTime();
    // Fox ESS requires a specific signature format for authentication
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
        // Send back the live data
        res.status(200).json({
            solar_kw: (data.pvPower / 1000).toFixed(2),
            battery_percent: data.soc,
            grid_kw: (data.gridPower / 1000).toFixed(2),
        });

    } catch (error) {
        console.error("Fox ESS API Error:", error.message);
        res.status(500).json({ error: `Failed to fetch from Fox ESS API.` });
    }
});

// Export the app to be used by Vercel's serverless environment
module.exports = app;
