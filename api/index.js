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
// This function manually handles the digest authentication process.
const performMyenergiRequest = async (username, password) => {
    // Step 1: Query the director service to find the correct server for this serial number
    let myenergiUrl;
    try {
        const directorResponse = await axios.get(`https://director.myenergi.net/cgi-jstatus-E`, {
            headers: { 'accept': 'application/json' },
            auth: { username, password } // The director also requires auth
        });
        myenergiUrl = `https://${directorResponse.headers['x_myenergi-asn']}`;
        if (!myenergiUrl.includes('/cgi-jstatus-E')) {
            myenergiUrl += '/cgi-jstatus-E';
        }
    } catch (directorError) {
        // If the director call itself fails, we can't proceed.
        // It's likely a credential issue.
        console.error("Myenergi Director API Error:", directorError.message);
        throw new Error('Authentication failed at Myenergi director. Please check credentials.');
    }

    const method = 'GET';
    
    try {
        // Step 2: Make an initial request to the *correct* server to get the auth challenge
        const initialResponse = await axios.get(myenergiUrl).catch(error => {
            if (error.response && error.response.status === 401) {
                return error.response; // This is the expected challenge
            }
            throw error;
        });

        // Step 3: Parse the 'WWW-Authenticate' header from the 401 response
        const authHeader = initialResponse.headers['www-authenticate'];
        const params = authHeader.split(/, | /).reduce((acc, part) => {
            const [key, value] = part.split(/=(.+)/);
            if (key) acc[key] = value.replace(/"/g, '');
            return acc;
        }, {});

        const { realm, qop, nonce, opaque } = params;

        // Step 4: Create the cryptographic hashes for the digest response
        const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
        const ha2 = crypto.createHash('md5').update(`${method}:${myenergiUrl.replace(/https?:\/\/[^\/]+/, '')}`).digest('hex');
        const cnonce = crypto.randomBytes(8).toString('hex');
        const nc = '00000001';
        const responseHash = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');

        // Step 5: Construct the final 'Authorization' header
        const authDetails = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${myenergiUrl.replace(/https?:\/\/[^\/]+/, '')}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${responseHash}", opaque="${opaque}"`;

        // Step 6: Make the fully authenticated request
        return await axios.get(myenergiUrl, {
            headers: { 'Authorization': authDetails }
        });

    } catch (error) {
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
    res.status(200).json({
      diversion_kw: (eddiData.div / 1000).toFixed(2),
      status: eddiData.stat
    });
  } catch (error) {
    console.error("Myenergi API Error:", error.message);
    res.status(500).json({ error: error.message });
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

