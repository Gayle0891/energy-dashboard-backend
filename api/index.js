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
// This function manually handles the digest authentication process with enhanced error logging.
const performMyenergiRequest = async (username, password) => {
    try {
        // Step 1: Contact the Myenergi director to get the correct server address.
        const directorUrl = 'https://director.myenergi.net/cgi-jstatus-E';
        console.log(`[Myenergi] Step 1: Contacting Director at ${directorUrl}`);
        const directorResponse = await axios.get(directorUrl, { validateStatus: () => true });

        // Step 2: Extract the server address (ASN) from the response headers.
        const serverAsn = directorResponse.headers['x_myenergi-asn'];
        if (!serverAsn) {
            console.error('[Myenergi] Director response headers:', directorResponse.headers);
            throw new Error("Director response did not contain 'x_myenergi-asn' header.");
        }
        console.log(`[Myenergi] Step 2: Director assigned server: ${serverAsn}`);
        
        // Step 3: Request the authentication challenge from the correct server.
        const myenergiApiEndpoint = `https://${serverAsn}/cgi-jstatus-E`;
        const method = 'GET';
        const uri = '/cgi-jstatus-E';
        console.log(`[Myenergi] Step 3: Requesting auth challenge from ${myenergiApiEndpoint}`);

        const challengeResponse = await axios.get(myenergiApiEndpoint).catch(error => {
            if (error.response && error.response.status === 401) {
                return error.response; // This is the expected challenge response.
            }
            // If it fails for any other reason, throw a detailed error.
            throw new Error(`Failed to get auth challenge. Server returned status: ${error.response?.status}`);
        });
        
        console.log("[Myenergi] Step 3: Successfully received auth challenge.");
        // Step 4: Parse the challenge header.
        const authHeader = challengeResponse.headers['www-authenticate'];
        if (!authHeader) throw new Error("WWW-Authenticate header missing in challenge response.");
        
        const params = authHeader.split(/, | /).reduce((acc, part) => {
            const [key, value] = part.split(/=(.+)/);
            if (key) acc[key] = value.replace(/"/g, '');
            return acc;
        }, {});

        const { realm, qop, nonce, opaque } = params;
        if (!realm || !nonce) throw new Error("Invalid WWW-Authenticate header received from server.");
        
        console.log("[Myenergi] Step 4: Successfully parsed challenge.");
        // Step 5: Construct the digest response and send the final authenticated request.
        const ha1 = crypto.createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
        const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
        const cnonce = crypto.randomBytes(8).toString('hex');
        const nc = '00000001';
        const responseHash = crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex');

        const authDetails = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", response="${responseHash}", opaque="${opaque}"`;
        
        console.log("[Myenergi] Step 5: Sending final authenticated request.");
        return await axios.get(myenergiApiEndpoint, { headers: { 'Authorization': authDetails } });

    } catch (error) {
        // This single catch block will now handle all errors in the process.
        console.error("[Myenergi] Full error in performMyenergiRequest:", error.message);
        throw new Error(`Myenergi request failed: ${error.message}`);
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
    console.error("Myenergi API Full Error:", error);
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
