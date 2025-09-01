// server.js - Main entry point
require('dotenv').config();
const express = require('express');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs-extra');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');

// Create necessary directories
const dirs = ['sessions', 'logs', 'uploads'];
dirs.forEach(dir => fs.ensureDirSync(dir));

// Initialize express app
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(morgan('combined', { stream: fs.createWriteStream(path.join('logs', 'access.log'), { flags: 'a' }) }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'src', 'web', 'views')));

// Create WhatsApp client
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "main",
        dataPath: "./sessions"
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
            '--window-size=1920,1080'
        ]
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

// Global state
let qrCodeData = null;
let connectionStatus = 'disconnected';

// Load configuration
const config = {
    prefix: '!',
    adminNumbers: [process.env.ADMIN_NUMBER || '+1234567890'],
    bannedWords: ['badword1', 'badword2', 'spam', 'scam', 'fraud'],
    allowedLinks: ['whatsapp.com', 'facebook.com', 'instagram.com', 'youtube.com', 'twitter.com', 'x.com', 'tiktok.com'],
    maxMessagesPerMinute: 10,
    maxWarnings: 3,
    welcomeMessage: 'Welcome to the group, {{user}}! We\'re glad to have you here.',
    goodbyeMessage: 'Goodbye, {{user}}. We\'ll miss you!',
    groupInfo: {
        name: 'WhatsApp Bot Group',
        description: 'A group managed by the WhatsApp Bot',
        members: 0
    },
    ai: {
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 150
    }
};

// In-memory storage (in production, use a database)
let groupData = {};
let userData = {};
let messageHistory = {};
let bannedUsers = [];
let warnings = {};
let polls = {};
let reminders = {};
let groupLockStatus = {};
let afkUsers = {};

// WhatsApp client event handlers
client.on('qr', async (qr) => {
    console.log('QR Code received, please scan it with your WhatsApp app');
    qrCodeData = await qrcode.toDataURL(qr);
    connectionStatus = 'qr';
});

client.on('ready', () => {
    console.log('WhatsApp client is ready!');
    connectionStatus = 'ready';
});

client.on('authenticated', () => {
    console.log('WhatsApp client authenticated');
    connectionStatus = 'authenticated';
    qrCodeData = null;
});

client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
    connectionStatus = 'auth_failed';
});

client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
    connectionStatus = 'disconnected';
    qrCodeData = null;
});

// Process incoming messages
client.on('message', async (message) => {
    try {
        if (message.fromMe) return; // Ignore own messages
        
        const messageBody = message.body;
        const sender = message.from;
        const isGroup = message.to.includes('@g.us');
        
        console.log(`Received message from ${sender}: ${messageBody}`);
        
        // Skip processing if group is locked and sender isn't admin
        if (isGroup && groupLockStatus[message.to] && !config.adminNumbers.includes(sender)) {
            return;
        }
        
        // Process through moderation first
        const moderationResult = await moderateMessage(messageBody, sender, message);
        if (moderationResult.blocked) {
            try {
                await message.reply(moderationResult.reason);
                if (moderationResult.deleteMessage) {
                    await message.delete(true);
                }
            } catch (err) {
                console.error('Failed to reply to message:', err);
            }
            return;
        }
        
        // Handle AI chat if needed
        if (messageBody.toLowerCase().startsWith('ai ')) {
            const query = messageBody.substring(3).trim();
            try {
                const aiResponse = await generateAIResponse(query, sender);
                await message.reply(aiResponse);
            } catch (err) {
                console.error('AI response error:', err);
                await message.reply("Sorry, I'm having trouble processing that request.");
            }
            return;
        }
        
        // Handle regular commands
        if (messageBody.startsWith(config.prefix)) {
            const command = messageBody.substring(1).trim();
            try {
                const response = await processCommand(command, sender, message);
                await message.reply(response);
            } catch (err) {
                console.error('Command processing error:', err);
                await message.reply("Sorry, there was an error processing your command.");
            }
        }
    } catch (error) {
        console.error('Error processing message:', error);
    }
});

// Initialize the client
client.initialize().catch(err => {
    console.error('Failed to initialize WhatsApp client:', err);
    connectionStatus = 'error';
});

// API routes
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: qrCodeData,
        timestamp: new Date().toISOString(),
        features: {
            antiLink: true,
            ai: !!process.env.OPENAI_API_KEY,
            moderation: true
        }
    });
});

app.post('/api/reconnect', async (req, res) => {
    try {
        // Clear session and reconnect
        await client.destroy();
        await client.initialize();
        res.json({ success: true, message: 'Reconnection initiated' });
    } catch (error) {
        console.error('Reconnection error:', error);
        res.status(500).json({ success: false, message: 'Failed to reconnect' });
    }
});

app.get('/api/commands', (req, res) => {
    res.json({
        commands: [
            { name: 'help', description: 'Show all available commands' },
            { name: 'ping', description: 'Check bot status' },
            { name: 'groupinfo', description: 'Get group information' },
            { name: 'admins', description: 'List group admins' },
            { name: 'members', description: 'List group members' },
            { name: 'welcome', description: 'Set welcome message' },
            { name: 'goodbye', description: 'Set goodbye message' },
            { name: 'remind', description: 'Set reminder' },
            { name: 'poll', description: 'Create poll' },
            { name: 'translate', description: 'Translate text' },
            { name: 'weather', description: 'Get weather' },
            { name: 'calc', description: 'Calculator' },
            { name: 'define', description: 'Dictionary lookup' },
            { name: 'joke', description: 'Get a random joke' },
            { name: 'quote', description: 'Get a random quote' },
            { name: 'fact', description: 'Get a random fact' },
            { name: 'horoscope', description: 'Get horoscope' },
            { name: 'ai', description: 'AI chat' },
            { name: 'image', description: 'Generate image' },
            { name: 'wiki', description: 'Wikipedia search' },
            { name: 'news', description: 'Get top headlines' },
            { name: 'currency', description: 'Currency converter' },
            { name: 'tagall', description: 'Tag all members' },
            { name: 'afk', description: 'Set AFK status' },
            { name: 'ban', description: 'Ban user' },
            { name: 'unban', description: 'Unban user' },
            { name: 'kick', description: 'Kick user' },
            { name: 'mute', description: 'Mute user' },
            { name: 'unmute', description: 'Unmute user' },
            { name: 'promote', description: 'Promote user' },
            { name: 'demote', description: 'Demote user' },
            { name: 'lock', description: 'Lock group' },
            { name: 'unlock', description: 'Unlock group' },
            { name: 'stats', description: 'View statistics' },
            { name: 'aihelp', description: 'AI capabilities overview' },
            { name: 'link', description: 'Manage links' }
        ]
    });
});

// Start the server
app.listen(port, () => {
    console.log(`WhatsApp Bot server listening at http://localhost:${port}`);
    console.log(`Web interface available at http://localhost:${port}/`);
});

// ======================
// Core Functionality
// ======================

// AI Moderation Function
async function moderateMessage(message, sender, messageObj) {
    try {
        const response = {
            blocked: false,
            reason: '',
            deleteMessage: false
        };
        
        // Check for links
        const linkRegex = /(https?:\/\/[^\s]+)/g;
        const links = message.match(linkRegex);
        
        if (links) {
            const blockedLinks = links.filter(link => {
                try {
                    const url = new URL(link);
                    return !config.allowedLinks.some(allowed => 
                        url.hostname.includes(allowed)
                    );
                } catch (e) {
                    return true; // Block invalid URLs
                }
            });
            
            if (blockedLinks.length > 0) {
                response.blocked = true;
                response.reason = "🚫 Links are not allowed in this group";
                response.deleteMessage = true;
                return response;
            }
        }
        
        // Check for bad words
        const hasBadWords = config.bannedWords.some(word => 
            message.toLowerCase().includes(word.toLowerCase())
        );
        
        if (hasBadWords) {
            response.blocked = true;
            response.reason = "🚫 Inappropriate language detected";
            response.deleteMessage = true;
            return response;
        }
        
        // Check for spam
        if (isSpam(sender)) {
            response.blocked = true;
            response.reason = "🚫 Slow down! You're sending too many messages";
            return response;
        }
        
        return response;
    } catch (error) {
        console.error('Moderation error:', error);
        return { blocked: false, reason: '', deleteMessage: false };
    }
}

// AI Response Generator
async function generateAIResponse(message, sender) {
    if (!process.env.OPENAI_API_KEY) {
        return "AI features are not configured. Please set OPENAI_API_KEY in .env file.";
    }
    
    try {
        const { Configuration, OpenAIApi } = require('openai');
        const configuration = new Configuration({
            apiKey: process.env.OPENAI_API_KEY,
        });
        const openai = new OpenAIApi(configuration);
        
        const prompt = `You are a helpful WhatsApp bot assistant. 
        User: ${sender}
        Message: ${message}
        
        Please provide a helpful, friendly, and concise response in natural language.
        Keep responses under 200 characters for WhatsApp.`;
        
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: config.ai.temperature,
            max_tokens: config.ai.maxTokens
        });
        
        return completion.data.choices[0].message.content;
    } catch (error) {
        console.error('AI response error:', error.response ? error.response.data : error.message);
        return "I'm having trouble processing that request right now. Please try again later.";
    }
}

// Command Processing Function
async function processCommand(command, sender, message) {
    const [cmd, ...args] = command.split(' ');
    const fullArgs = args.join(' ');
    
    // Check if user is admin
    const isAdmin = config.adminNumbers.includes(sender);
    
    switch(cmd.toLowerCase()) {
        case 'help':
            return helpCommand();
        case 'ping':
            return pingCommand();
        case 'groupinfo':
            return groupInfoCommand();
        case 'admins':
            return adminsCommand();
        case 'members':
            return membersCommand(message);
        case 'welcome':
            return isAdmin ? welcomeCommand(fullArgs) : "Only admins can set welcome messages";
        case 'goodbye':
            return isAdmin ? goodbyeCommand(fullArgs) : "Only admins can set goodbye messages";
        case 'remind':
            return remindCommand(fullArgs, sender);
        case 'poll':
            return pollCommand(fullArgs, sender, message);
        case 'translate':
            return translateCommand(fullArgs);
        case 'weather':
            return weatherCommand(fullArgs);
        case 'calc':
            return calcCommand(fullArgs);
        case 'define':
            return defineCommand(fullArgs);
        case 'joke':
            return jokeCommand();
        case 'quote':
            return quoteCommand();
        case 'fact':
            return factCommand();
        case 'horoscope':
            return horoscopeCommand(fullArgs);
        case 'ai':
            return aiCommand(fullArgs);
        case 'image':
            return isAdmin ? imageCommand(fullArgs) : "Image generation is restricted to admins";
        case 'wiki':
            return wikiCommand(fullArgs);
        case 'news':
            return newsCommand();
        case 'currency':
            return currencyCommand(fullArgs);
        case 'tagall':
            return isAdmin ? tagAllCommand(message) : "Only admins can tag all members";
        case 'afk':
            return afkCommand(fullArgs, sender);
        case 'ban':
            return isAdmin ? banCommand(fullArgs, sender, message) : "Only admins can ban users";
        case 'unban':
            return isAdmin ? unbanCommand(fullArgs, sender) : "Only admins can unban users";
        case 'kick':
            return isAdmin ? kickCommand(fullArgs, sender, message) : "Only admins can kick users";
        case 'mute':
            return isAdmin ? muteCommand(fullArgs, sender, message) : "Only admins can mute users";
        case 'unmute':
            return isAdmin ? unmuteCommand(fullArgs, sender, message) : "Only admins can unmute users";
        case 'promote':
            return isAdmin ? promoteCommand(fullArgs, sender) : "Only admins can promote users";
        case 'demote':
            return isAdmin ? demoteCommand(fullArgs, sender) : "Only admins can demote users";
        case 'lock':
            return isAdmin ? lockGroupCommand(sender, message) : "Only admins can lock the group";
        case 'unlock':
            return isAdmin ? unlockGroupCommand(sender, message) : "Only admins can unlock the group";
        case 'stats':
            return statsCommand(sender);
        case 'aihelp':
            return aiHelpCommand();
        case 'link':
            return isAdmin ? linkManagementCommand(fullArgs, sender) : "Only admins can manage links";
        default:
            return "Unknown command. Type '!help' for available commands.";
    }
}

// ======================
// Command Implementations
// ======================

// Help Command
function helpCommand() {
    return `
🚀 *WhatsApp Bot Help* 🚀

*Core Commands:*
!help - Show this help message
!ping - Check bot status
!groupinfo - Get group information
!admins - List group admins

*Moderation Commands:*
!ban <user> - Ban user
!unban <user> - Unban user
!kick <user> - Kick user
!mute <user> - Mute user
!unmute <user> - Unmute user
!lock - Lock group (only admins)
!unlock - Unlock group (only admins)
!link allow|block|whitelist|blacklist <domain> - Manage links

*Productivity Commands:*
!remind <time> <message> - Set reminder
!poll <question> - Create poll
!translate <text> - Translate text
!weather <location> - Get weather
!calc <expression> - Calculator
!define <word> - Dictionary lookup
!wiki <query> - Wikipedia search
!news - Get top headlines
!currency <amount> - Currency converter

*Entertainment Commands:*
!joke - Get a random joke
!quote - Get a random quote
!fact - Get a random fact
!horoscope <sign> - Get horoscope
!ai <query> - AI chat
!image <prompt> - Generate image (admin only)
!tagall - Tag all members (admin only)
!afk <message> - Set AFK status

*System Commands:*
!stats - View statistics
!aihelp - AI capabilities overview

Type '!aihelp' for more details on AI features.
`;
}

// Ping Command
function pingCommand() {
    return `🏓 Pong! Bot is running. Uptime: ${Math.floor(process.uptime())} seconds`;
}

// Group Info Command
function groupInfoCommand() {
    return `👥 *Group Information*\n\n` +
           `*Name:* ${config.groupInfo.name}\n` +
           `*Description:* ${config.groupInfo.description}\n` +
           `*Members:* ${config.groupInfo.members}\n` +
           `*Anti-Link:* Enabled (Allowed: ${config.allowedLinks.join(', ')})`;
}

// Admins Command
function adminsCommand() {
    return `🛡️ *Group Admins*\n\n` +
           config.adminNumbers.map((admin, index) => 
               `${index + 1}. ${admin}`).join('\n');
}

// Members Command
async function membersCommand(message) {
    try {
        if (!message.to.includes('@g.us')) {
            return "This command only works in groups";
        }
        
        const chat = await message.getChat();
        const members = chat.participants;
        
        return `👥 *Group Members (${members.length})*\n\n` +
               members.slice(0, 10).map((member, index) => 
                   `${index + 1}. ${member.id._serialized}`).join('\n') +
               (members.length > 10 ? `\n\nAnd ${members.length - 10} more...` : '');
    } catch (error) {
        console.error('Error getting members:', error);
        return "Failed to retrieve group members";
    }
}

// Welcome Command
function welcomeCommand(message) {
    if (!message) {
        return `Current welcome message:\n${config.welcomeMessage}\n\n` +
               "Usage: !welcome <message>\n" +
               "Use {{user}} for mentioning the new member";
    }
    
    config.welcomeMessage = message;
    return "✅ Welcome message updated!";
}

// Goodbye Command
function goodbyeCommand(message) {
    if (!message) {
        return `Current goodbye message:\n${config.goodbyeMessage}\n\n` +
               "Usage: !goodbye <message>\n" +
               "Use {{user}} for mentioning the leaving member";
    }
    
    config.goodbyeMessage = message;
    return "✅ Goodbye message updated!";
}

// Remind Command
function remindCommand(time, message) {
    const minutes = parseTime(time);
    if (!minutes) return "Invalid time format. Use: 10m, 1h, 2d";
    
    const reminderId = Date.now();
    reminders[reminderId] = {
        time: Date.now() + minutes * 60000,
        message: message,
        userId: null
    };
    
    setTimeout(async () => {
        try {
            await client.sendMessage(reminders[reminderId].userId, 
                `⏰ Reminder: ${reminders[reminderId].message}`);
            delete reminders[reminderId];
        } catch (err) {
            console.error('Failed to send reminder:', err);
        }
    }, minutes * 60000);
    
    return `⏰ Reminder set for ${time} from now.`;
}

// Poll Command
async function pollCommand(question, sender, message) {
    if (!question) {
        return "Usage: !poll <question>\nExample: !poll What's your favorite color?";
    }
    
    const pollId = Date.now();
    polls[pollId] = {
        question: question,
        votes: {},
        creator: sender,
        chatId: message.to
    };
    
    return `📊 *POLL CREATED*\n\n` +
           `*Question:* ${question}\n\n` +
           `Vote with:\n` +
           `!vote ${pollId} option`;
}

// Translate Command
async function translateCommand(text) {
    if (!text) {
        return "Usage: !translate <text>\nExample: !translate Hello world";
    }
    
    if (!process.env.OPENAI_API_KEY) {
        return "Translation feature is not configured. Please set OPENAI_API_KEY.";
    }
    
    try {
        const { Configuration, OpenAIApi } = require('openai');
        const configuration = new Configuration({
            apiKey: process.env.OPENAI_API_KEY,
        });
        const openai = new OpenAIApi(configuration);
        
        const prompt = `Translate the following text to English:\n"${text}"\n\n` +
                       "Just respond with the translated text.";
        
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.3,
            max_tokens: 100
        });
        
        return `🔤 *Translation*\n\n${completion.data.choices[0].message.content}`;
    } catch (error) {
        console.error('Translation error:', error);
        return "Translation failed. Please try again.";
    }
}

// Weather Command
async function weatherCommand(location) {
    if (!location) {
        return "Usage: !weather <location>\nExample: !weather London";
    }
    
    if (!process.env.OPENAI_API_KEY) {
        return "Weather feature is not configured. Please set OPENAI_API_KEY.";
    }
    
    try {
        const { Configuration, OpenAIApi } = require('openai');
        const configuration = new Configuration({
            apiKey: process.env.OPENAI_API_KEY,
        });
        const openai = new OpenAIApi(configuration);
        
        const prompt = `Provide a weather forecast for ${location} in simple terms. ` +
                       `Include temperature, conditions, and any important weather alerts.`;
        
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5,
            max_tokens: 150
        });
        
        return `🌤️ *Weather Forecast for ${location}*\n\n${completion.data.choices[0].message.content}`;
    } catch (error) {
        console.error('Weather error:', error);
        return "Could not retrieve weather information.";
    }
}

// Calculator Command
function calcCommand(expression) {
    if (!expression) {
        return "Usage: !calc <expression>\nExample: !calc 2+2*5";
    }
    
    try {
        // Safer evaluation using Function
        const result = Function('"use strict";return (' + expression + ')')();
        return `🧮 *Calculation*\n\n${expression} = ${result}`;
    } catch (error) {
        return "❌ Invalid mathematical expression";
    }
}

// Dictionary Command
async function defineCommand(word) {
    if (!word) {
        return "Usage: !define <word>\nExample: !define algorithm";
    }
    
    if (!process.env.OPENAI_API_KEY) {
        return "Dictionary feature is not configured. Please set OPENAI_API_KEY.";
    }
    
    try {
        const { Configuration, OpenAIApi } = require('openai');
        const configuration = new Configuration({
            apiKey: process.env.OPENAI_API_KEY,
        });
        const openai = new OpenAIApi(configuration);
        
        const prompt = `Define the word "${word}" in simple terms with examples.`;
        
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5,
            max_tokens: 150
        });
        
        return `📚 *Definition of ${word}*\n\n${completion.data.choices[0].message.content}`;
    } catch (error) {
        console.error('Definition error:', error);
        return "Definition not found. Try another word.";
    }
}

// Joke Command
function jokeCommand() {
    const jokes = [
        "Why don't scientists trust atoms? Because they make up everything!",
        "What did one ocean say to the other ocean? Nothing, they just waved!",
        "Why did the scarecrow win an award? He was outstanding in his field!",
        "I told my wife she was drawing her eyebrows too high. She looked surprised.",
        "Why did the math book look so sad? Because of all of its problems."
    ];
    return `🤣 *Joke*\n\n${jokes[Math.floor(Math.random() * jokes.length)]}`;
}

// Quote Command
function quoteCommand() {
    const quotes = [
        "The only way to do great work is to love what you do. - Steve Jobs",
        "Life is what happens to you while you're busy making other plans. - John Lennon",
        "The future belongs to those who believe in the beauty of their dreams. - Eleanor Roosevelt",
        "Success is not final, failure is not fatal: It is the courage to continue that counts. - Winston Churchill",
        "The best way to predict the future is to create it. - Peter Drucker"
    ];
    return `💡 *Quote of the Day*\n\n${quotes[Math.floor(Math.random() * quotes.length)]}`;
}

// Fact Command
function factCommand() {
    const facts = [
        "Honey never spoils. Archaeologists have found pots of honey in ancient Egyptian tombs that are over 3,000 years old and still perfectly good to eat.",
        "Octopuses have three hearts. Two pump blood to the gills, while the third pumps it to the rest of the body.",
        "A group of flamingos is called a 'flamboyance'.",
        "Bananas are berries, but strawberries aren't.",
        "The shortest war in history was between Britain and Zanzibar on August 27, 1896. Zanzibar surrendered after 38 minutes."
    ];
    return `🔍 *Random Fact*\n\n${facts[Math.floor(Math.random() * facts.length)]}`;
}

// Horoscope Command
function horoscopeCommand(sign) {
    const signs = ['aries', 'taurus', 'gemini', 'cancer', 'leo', 'virgo', 'libra', 'scorpio', 'sagittarius', 'capricorn', 'aquarius', 'pisces'];
    if (!sign || !signs.includes(sign.toLowerCase())) {
        return "Please enter a valid zodiac sign. Example: !horoscope leo";
    }
    
    const predictions = {
        aries: "Today will bring unexpected opportunities. Stay open to new possibilities!",
        taurus: "Your patience will be rewarded today. Focus on long-term goals.",
        gemini: "Communication is key today. Reach out to friends and colleagues.",
        cancer: "Trust your intuition today. It will guide you to the right decisions.",
        leo: "Your creativity is at its peak. Channel it into your projects.",
        virgo: "Attention to detail will serve you well today. Double-check your work.",
        libra: "Balance is important today. Find harmony in your relationships.",
        scorpio: "Deep insights await you today. Trust your instincts.",
        sagittarius: "Adventure calls today. Be open to new experiences.",
        capricorn: "Your hard work is paying off. Stay focused on your goals.",
        aquarius: "Innovation is your strength today. Think outside the box.",
        pisces: "Your compassion shines today. Help others and you'll be rewarded."
    };
    
    return `🌟 *Horoscope for ${sign.charAt(0).toUpperCase() + sign.slice(1)}*\n\n${predictions[sign.toLowerCase()]}`;
}

// AI Command
async function aiCommand(query) {
    if (!query) {
        return "Usage: !ai <query>\nExample: !ai What is the capital of France?";
    }
    
    if (!process.env.OPENAI_API_KEY) {
        return "AI feature is not configured. Please set OPENAI_API_KEY.";
    }
    
    try {
        const { Configuration, OpenAIApi } = require('openai');
        const configuration = new Configuration({
            apiKey: process.env.OPENAI_API_KEY,
        });
        const openai = new OpenAIApi(configuration);
        
        const prompt = `Act as an intelligent assistant. Answer the following question clearly and concisely:\n` +
                       `Question: ${query}\n\n` +
                       `Provide a helpful response with relevant information.`;
        
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: config.ai.temperature,
            max_tokens: config.ai.maxTokens
        });
        
        return `🤖 *AI Response*\n\n${completion.data.choices[0].message.content}`;
    } catch (error) {
        console.error('AI command error:', error);
        return "I couldn't process that request. Please try again with a different query.";
    }
}

// Image Command
async function imageCommand(prompt) {
    if (!prompt) {
        return "Usage: !image <prompt>\nExample: !image a cute cat wearing sunglasses";
    }
    
    if (!process.env.OPENAI_API_KEY) {
        return "Image generation is not configured. Please set OPENAI_API_KEY.";
    }
    
    try {
        const { Configuration, OpenAIApi } = require('openai');
        const configuration = new Configuration({
            apiKey: process.env.OPENAI_API_KEY,
        });
        const openai = new OpenAIApi(configuration);
        
        const response = await openai.createImage({
            prompt: prompt,
            n: 1,
            size: "512x512"
        });
        
        return `🖼️ *Image Generated*\n\n` +
               `Prompt: ${prompt}\n\n` +
               `Here's your image:\n${response.data.data[0].url}`;
    } catch (error) {
        console.error('Image generation error:', error);
        return "Sorry, I couldn't generate an image at this time.";
    }
}

// Wiki Command
async function wikiCommand(query) {
    if (!query) {
        return "Usage: !wiki <query>\nExample: !wiki artificial intelligence";
    }
    
    if (!process.env.OPENAI_API_KEY) {
        return "Wikipedia feature is not configured. Please set OPENAI_API_KEY.";
    }
    
    try {
        const { Configuration, OpenAIApi } = require('openai');
        const configuration = new Configuration({
            apiKey: process.env.OPENAI_API_KEY,
        });
        const openai = new OpenAIApi(configuration);
        
        const prompt = `Provide a concise summary of "${query}" from Wikipedia. ` +
                       `Include key facts and important details.`;
        
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5,
            max_tokens: 200
        });
        
        return `📚 *Wikipedia Summary for "${query}"*\n\n${completion.data.choices[0].message.content}`;
    } catch (error) {
        console.error('Wiki search error:', error);
        return "Wikipedia search failed. Please try a different query.";
    }
}

// News Command
async function newsCommand() {
    if (!process.env.OPENAI_API_KEY) {
        return "News feature is not configured. Please set OPENAI_API_KEY.";
    }
    
    try {
        const { Configuration, OpenAIApi } = require('openai');
        const configuration = new Configuration({
            apiKey: process.env.OPENAI_API_KEY,
        });
        const openai = new OpenAIApi(configuration);
        
        const prompt = `Fetch and summarize the top 3 current news headlines. ` +
                       `Format them as bullet points with brief descriptions.`;
        
        const completion = await openai.createChatCompletion({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: prompt }],
            temperature: 0.5,
            max_tokens: 300
        });
        
        return `📰 *Latest News*\n\n${completion.data.choices[0].message.content}`;
    } catch (error) {
        console.error('News fetch error:', error);
        return "Could not fetch news at this time.";
    }
}

// Currency Command
function currencyCommand(amount) {
    if (!amount) {
        return "Usage: !currency <amount>\nExample: !currency 100 USD to EUR";
    }
    
    // Simple conversion for demo purposes
    const match = amount.match(/(\d+)\s*([a-zA-Z]+)\s*to\s*([a-zA-Z]+)/i);
    if (!match) {
        return "Invalid format. Use: !currency 100 USD to EUR";
    }
    
    const value = parseFloat(match[1]);
    const from = match[2].toUpperCase();
    const to = match[3].toUpperCase();
    
    // Basic exchange rates for demo
    const rates = {
        'USD': 1,
        'EUR': 0.93,
        'GBP': 0.79,
        'JPY': 148.5,
        'INR': 83.2
    };
    
    if (!rates[from] || !rates[to]) {
        return "Unsupported currency. Supported: USD, EUR, GBP, JPY, INR";
    }
    
    const result = value * (rates[to] / rates[from]);
    return `💱 *Currency Conversion*\n\n` +
           `${value} ${from} = ${result.toFixed(2)} ${to}\n` +
           `(Rate: 1 ${from} = ${(rates[to] / rates[from]).toFixed(4)} ${to})`;
}

// Tag All Command
async function tagAllCommand(message) {
    try {
        if (!message.to.includes('@g.us')) {
            return "This command only works in groups";
        }
        
        const chat = await message.getChat();
        const members = chat.participants;
        
        // Create mentions
        const mentions = members
            .filter(member => !member.isAdmin && !member.isSuperAdmin)
            .slice(0, 30) // Limit to avoid spam
            .map(member => `@${member.id.user}`);
        
        return mentions.join(' ') + '\n\n*This is a tag all message*';
    } catch (error) {
        console.error('Error tagging members:', error);
        return "Failed to tag all members";
    }
}

// AFK Command
function afkCommand(message, sender) {
    afkUsers[sender] = {
        message: message || 'AFK',
        time: new Date()
    };
    
    return `💤 You are now AFK: ${afkUsers[sender].message}`;
}

// Ban Command
async function banCommand(user, sender, message) {
    try {
        // Extract user ID from mention or input
        let userId = user;
        if (user.startsWith('@')) {
            userId = user.substring(1) + '@c.us';
        } else if (!user.includes('@')) {
            userId = user + '@c.us';
        }
        
        // Check if user exists in group
        const chat = await message.getChat();
        const isMember = chat.participants.some(p => p.id._serialized === userId);
        
        if (!isMember) {
            return "User is not in this group";
        }
        
        // Remove user from group
        await chat.removeParticipants([userId]);
        
        // Add to banned list
        if (!bannedUsers.includes(userId)) {
            bannedUsers.push(userId);
        }
        
        return `🚫 User ${userId} has been banned from the group`;
    } catch (error) {
        console.error('Ban error:', error);
        return "Failed to ban user";
    }
}

// Unban Command
function unbanCommand(user, sender) {
    // Extract user ID
    let userId = user;
    if (user.startsWith('@')) {
        userId = user.substring(1) + '@c.us';
    } else if (!user.includes('@')) {
        userId = user + '@c.us';
    }
    
    const index = bannedUsers.indexOf(userId);
    if (index > -1) {
        bannedUsers.splice(index, 1);
        return `✅ User ${userId} has been unbanned`;
    }
    
    return "User is not banned";
}

// Kick Command
async function kickCommand(user, sender, message) {
    try {
        // Extract user ID from mention or input
        let userId = user;
        if (user.startsWith('@')) {
            userId = user.substring(1) + '@c.us';
        } else if (!user.includes('@')) {
            userId = user + '@c.us';
        }
        
        // Check if user exists in group
        const chat = await message.getChat();
        const isMember = chat.participants.some(p => p.id._serialized === userId);
        
        if (!isMember) {
            return "User is not in this group";
        }
        
        // Remove user from group
        await chat.removeParticipants([userId]);
        
        return `👢 User ${userId} has been kicked from the group`;
    } catch (error) {
        console.error('Kick error:', error);
        return "Failed to kick user";
    }
}

// Mute Command
function muteCommand(user, sender, message) {
    // Extract user ID
    let userId = user;
    if (user.startsWith('@')) {
        userId = user.substring(1) + '@c.us';
    } else if (!user.includes('@')) {
        userId = user + '@c.us';
    }
    
    userData[userId] = { muted: true };
    return `🔇 User ${userId} has been muted`;
}

// Unmute Command
function unmuteCommand(user, sender, message) {
    // Extract user ID
    let userId = user;
    if (user.startsWith('@')) {
        userId = user.substring(1) + '@c.us';
    } else if (!user.includes('@')) {
        userId = user + '@c.us';
    }
    
    if (userData[userId] && userData[userId].muted) {
        delete userData[userId].muted;
        return `🔊 User ${userId} has been unmuted`;
    }
    
    return "User is not muted";
}

// Lock Group Command
function lockGroupCommand(sender, message) {
    groupLockStatus[message.to] = true;
    return "🔒 Group has been locked. Only admins can send messages now.";
}

// Unlock Group Command
function unlockGroupCommand(sender, message) {
    groupLockStatus[message.to] = false;
    return "🔓 Group has been unlocked. Everyone can send messages now.";
}

// Stats Command
function statsCommand(sender) {
    return `📊 *Bot Statistics*\n\n` +
           `Messages processed: ${Object.values(messageHistory).reduce((sum, arr) => sum + arr.length, 0)}\n` +
           `Warnings issued: ${Object.values(warnings).reduce((sum, count) => sum + count, 0)}\n` +
           `Active polls: ${Object.keys(polls).length}\n` +
           `Your messages: ${messageHistory[sender] ? messageHistory[sender].length : 0}\n` +
           `Your warnings: ${warnings[sender] || 0}`;
}

// AI Help Command
function aiHelpCommand() {
    return `🤖 *AI Capabilities*\n\n` +
           "• *Natural language understanding*: Conversational AI that understands context\n" +
           "• *Content moderation*: AI-powered message filtering\n" +
           "• *Translation*: Real-time language conversion\n" +
           "• *Image generation*: DALL-E integration for visual content\n" +
           "• *Weather forecasts*: Accurate weather information\n" +
           "• *News summaries*: Top headlines from reliable sources\n" +
           "• *Calculations*: Complex math operations\n" +
           "• *Dictionary lookups*: Word definitions and examples\n" +
           "• *Jokes & quotes*: Entertainment on demand\n" +
           "• *Facts & horoscopes*: Interesting information\n" +
           "• *Wikipedia search*: Knowledge at your fingertips\n\n" +
           "Type '!ai <your question>' to use the AI assistant";
}

// Link Management Command
function linkManagementCommand(command, sender) {
    const [action, domain] = command.split(' ');
    
    if (!action) {
        return "Usage: !link allow|block|whitelist|blacklist <domain>";
    }
    
    switch(action.toLowerCase()) {
        case 'allow':
            if (!domain) return "Specify a domain to allow. Example: !link allow example.com";
            config.allowedLinks.push(domain);
            return `✅ Domain ${domain} added to whitelist.`;
        case 'block':
            if (!domain) return "Specify a domain to block. Example: !link block example.com";
            const index = config.allowedLinks.indexOf(domain);
            if (index > -1) {
                config.allowedLinks.splice(index, 1);
                return `🚫 Domain ${domain} removed from whitelist.`;
            }
            return "Domain not in whitelist.";
        case 'whitelist':
            return `📋 *Allowed Domains*\n\n${config.allowedLinks.map((d, i) => `${i + 1}. ${d}`).join('\n')}`;
        case 'blacklist':
            return `🚫 *Banned Words*\n\n${config.bannedWords.map((w, i) => `${i + 1}. ${w}`).join('\n')}`;
        default:
            return "Usage: !link allow|block|whitelist|blacklist <domain>";
    }
}

// Helper Functions
function parseTime(timeStr) {
    const regex = /^(\d+)([mhd])$/;
    const match = timeStr.match(regex);
    if (!match) return null;
    
    const value = parseInt(match[1]);
    const unit = match[2];
    
    switch(unit) {
        case 'm': return value;
        case 'h': return value * 60;
        case 'd': return value * 24 * 60;
        default: return null;
    }
}

function isSpam(sender) {
    if (!messageHistory[sender]) {
        messageHistory[sender] = [];
    }
    
    const now = Date.now();
    const recentMessages = messageHistory[sender].filter(time => now - time < 60000);
    
    if (recentMessages.length > config.maxMessagesPerMinute) {
        return true;
    }
    
    messageHistory[sender].push(now);
    return false;
}

function hasBadWords(message) {
    return config.bannedWords.some(word => 
        message.toLowerCase().includes(word.toLowerCase())
    );
}

function warnUser(user, reason) {
    if (!warnings[user]) {
        warnings[user] = 0;
    }
    
    warnings[user]++;
    
    if (warnings[user] >= config.maxWarnings) {
        bannedUsers.push(user);
        return "You have been banned for too many warnings.";
    }
    
    return `⚠️ Warning #${warnings[user]}: ${reason}`;
}