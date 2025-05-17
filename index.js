const restify = require('restify');
const axios = require('axios');
require('dotenv').config();
const { CloudAdapter, ConfigurationServiceClientCredentialFactory, ConfigurationBotFrameworkAuthentication } = require('botbuilder');

// Session management variables
const sessionCache = new Map(); // Map to store sessions by conversationId
const SESSION_TIMEOUT = (process.env.MIN_SESSION || 30) * 60 * 1000; // 30 minutes timeout (adjust as needed)

const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: process.env.BOT_ID,
    MicrosoftAppPassword: process.env.BOT_PASSWORD
});
const botAuth = new ConfigurationBotFrameworkAuthentication({}, credentialsFactory);
const adapter = new CloudAdapter(botAuth);

adapter.onTurnError = async (context, error) => {
    console.error(`[ERROR] ${error}`);
    await context.sendActivity("Oops! Something went wrong.");
};

async function getSalesforceToken() {
    try {
        const response = await axios.post(process.env.SF_TOKEN_URL, new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: process.env.SF_CLIENT_ID,
            client_secret: process.env.SF_CLIENT_SECRET
        }));
        return response.data.access_token;
    } catch (error) {
        console.error("❌ Error getting Salesforce token:", error.response?.data || error.message);
        throw new Error("Failed to get Salesforce token.");
    }
}

async function createEinsteinSession(accessToken, conversationId) {
    try {
        const response = await axios.post(process.env.SF_SESSION_URL, {
            externalSessionKey: `teams-chat-${conversationId}`,
            instanceConfig: { endpoint: process.env.SF_INSTANCE_URL },
            streamingCapabilities: { chunkTypes: ["Text"] },
            bypassUser: true
        }, { headers: { Authorization: `Bearer ${accessToken}` } });
        
        console.log(`✅ Created new session for conversation ${conversationId}`);
        return response.data.sessionId;
    } catch (error) {
        console.error("❌ Error creating Einstein AI session:", error.response?.data || error.message);
        throw new Error("Failed to create Einstein AI session.");
    }
}

async function sendEinsteinMessage(accessToken, sessionId, userMessage) {
    try {
        const response = await axios.post(`${process.env.SF_MESSAGE_URL}/${sessionId}/messages`, {
            message: { sequenceId: Date.now(), type: "Text", text: userMessage },
            variables: []
        }, { headers: { Authorization: `Bearer ${accessToken}` } });
        return response.data.messages[0].message;
    } catch (error) {
        // Check if error is due to invalid session
        if (error.response?.status === 404 || 
            (error.response?.data && error.response?.data.includes("session not found"))) {
            throw new Error("SESSION_EXPIRED");
        }
        console.error("❌ Error sending message to Einstein AI:", error.response?.data || error.message);
        throw new Error("Failed to send message to Einstein AI.");
    }
}

// Function to get or create a session
async function getOrCreateSession(conversationId, accessToken) {
    // Check if we have a valid session cached
    const cachedSession = sessionCache.get(conversationId);
    const now = Date.now();
    
    if (cachedSession && (now - cachedSession.timestamp < SESSION_TIMEOUT)) {
        console.log(`♻️ Reusing existing session for conversation ${conversationId}`);
        return cachedSession.sessionId;
    }
    
    // Create a new session
    const sessionId = await createEinsteinSession(accessToken, conversationId);
    
    // Cache the new session
    sessionCache.set(conversationId, {
        sessionId,
        timestamp: now
    });
    
    return sessionId;
}

const botLogic = async (context) => {
    if (context.activity.type === 'message') {
        const userMessage = context.activity.text;
        const conversationId = context.activity.conversation.id;
        
        console.log(`📩 Message received from conversation ${conversationId}:`, context.activity.text);
        await context.sendActivity("⏳ "+(process.env.STATUS_MESSAGE || "Processing your request..."));
        
        try {
            const accessToken = await getSalesforceToken();
            let sessionId;
            let retryWithNewSession = false;
            
            try {
                // Try to get existing session or create a new one
                sessionId = await getOrCreateSession(conversationId, accessToken);
                const responseMessage = await sendEinsteinMessage(accessToken, sessionId, userMessage);
                await context.sendActivity(responseMessage);
            } catch (error) {
                if (error.message === "SESSION_EXPIRED" && !retryWithNewSession) {
                    // Session expired, clear cache and create a new session
                    console.log(`⚠️ Session expired for conversation ${conversationId}, creating new session`);
                    sessionCache.delete(conversationId);
                    retryWithNewSession = true;
                    
                    // Retry with new session
                    sessionId = await getOrCreateSession(conversationId, accessToken);
                    const responseMessage = await sendEinsteinMessage(accessToken, sessionId, userMessage);
                    await context.sendActivity(responseMessage);
                } else {
                    throw error; // Re-throw if it's not a session expiry or we already retried
                }
            }
        } catch (error) {
            console.error(`❌ Error processing message: ${error.message}`);
            await context.sendActivity("❌ Error communicating with Salesforce Einstein AI.");
        }
    }
};

// Cleanup old sessions periodically
setInterval(() => {
    const now = Date.now();
    let expiredCount = 0;
    
    sessionCache.forEach((session, conversationId) => {
        if (now - session.timestamp > SESSION_TIMEOUT) {
            sessionCache.delete(conversationId);
            expiredCount++;
        }
    });
    
    if (expiredCount > 0) {
        console.log(`🧹 Cleaned up ${expiredCount} expired sessions`);
    }
}, 15 * 60 * 1000); // Run cleanup every 15 minutes

const server = restify.createServer();
server.use(restify.plugins.bodyParser());

server.post('/api/messages', async (req, res) => {
    await adapter.process(req, res, botLogic);
});

server.get('/api/messages/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    
    const conversationId = req.query.conversationId || 'default-conversation';
    
    try {
        const accessToken = await getSalesforceToken();
        
        // Use the same session management logic here
        let sessionId;
        try {
            sessionId = await getOrCreateSession(conversationId, accessToken);
        } catch (error) {
            console.error(`❌ Error getting session: ${error.message}`);
            sessionCache.delete(conversationId);
            sessionId = await getOrCreateSession(conversationId, accessToken);
        }
        
        const streamUrl = `${process.env.SF_MESSAGE_URL}/${sessionId}/messages/stream`;
        
        const response = await axios({
            method: 'post',
            url: streamUrl,
            headers: {
                'Accept': 'text/event-stream',
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            },
            data: {
                message: { sequenceId: Date.now(), type: "Text", text: req.query.message },
                variables: []
            },
            responseType: 'stream'
        });

        response.data.on('data', (chunk) => {
            res.write(`data: ${chunk}\n\n`);
        });

        response.data.on('end', () => {
            res.write("event: done\n\n");
            res.end();
        });
    } catch (error) {
        res.write(`event: error\ndata: ${JSON.stringify(error.response?.data || error.message)}\n\n`);
        res.end();
    }
});

server.listen(process.env.PORT || 3978, () => {
   console.log(`🚀 Agentforce is running on port ${server.address().port}`);
   console.log(`⏱️ Session timeout set to ${SESSION_TIMEOUT/60000} minutes`);
});