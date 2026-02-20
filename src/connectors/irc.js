import net from "node:net";
import tls from "node:tls";
import { Buffer } from "node:buffer";
import { createAiResponse } from "../ai.js";

function escapeRegex(value = "") {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractNick(prefix = "") {
  return prefix.split("!")[0] || prefix;
}

function isMentioningBot(text = "", nick = "") {
  if (!text || !nick) {
    return false;
  }

  const escaped = escapeRegex(nick);
  const mentionPattern = new RegExp(`(^|\\s)@?${escaped}([,:]?\\s|$)`, "i");
  return mentionPattern.test(text);
}

function stripBotMention(text = "", nick = "") {
  if (!text || !nick) {
    return text.trim();
  }

  const escaped = escapeRegex(nick);
  const prefixPattern = new RegExp(`^\\s*@?${escaped}[,:]?\\s*`, "i");
  return text.replace(prefixPattern, "").trim();
}

function splitIrcMessage(text = "", maxLength = 380) {
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf(" ", maxLength);
    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function parseIrcLine(raw = "") {
  if (!raw) {
    return null;
  }

  let line = raw;

  if (line.startsWith("@")) {
    const tagEnd = line.indexOf(" ");
    if (tagEnd === -1) {
      return null;
    }
    line = line.slice(tagEnd + 1);
  }

  let prefix = null;
  if (line.startsWith(":")) {
    const prefixEnd = line.indexOf(" ");
    if (prefixEnd === -1) {
      return null;
    }
    prefix = line.slice(1, prefixEnd);
    line = line.slice(prefixEnd + 1);
  }

  const firstSpace = line.indexOf(" ");
  const command = (firstSpace === -1 ? line : line.slice(0, firstSpace)).toUpperCase();
  let rest = firstSpace === -1 ? "" : line.slice(firstSpace + 1);
  const params = [];

  while (rest.length) {
    if (rest.startsWith(":")) {
      params.push(rest.slice(1));
      break;
    }

    const nextSpace = rest.indexOf(" ");
    if (nextSpace === -1) {
      params.push(rest);
      break;
    }

    params.push(rest.slice(0, nextSpace));
    rest = rest.slice(nextSpace + 1);
    while (rest.startsWith(" ")) {
      rest = rest.slice(1);
    }
  }

  return { raw, prefix, command, params };
}

function buildSaslPlainChunks(username, password) {
  const payload = Buffer.from(`\u0000${username}\u0000${password}`, "utf8").toString("base64");
  const chunkSize = 400;
  const chunks = [];

  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    chunks.push(payload.slice(offset, offset + chunkSize));
  }

  if (!chunks.length || payload.length % chunkSize === 0) {
    chunks.push("+");
  }

  return chunks;
}

function hasCapability(capabilityList = "", target = "") {
  const normalizedTarget = target.toLowerCase();
  return capabilityList
    .toLowerCase()
    .split(/\s+/)
    .map((item) => item.replace(/^[-=~]/, "").split("=")[0])
    .some((item) => item === normalizedTarget);
}

export async function startIrcBot(config, options) {
  const { maxThreadHistory } = options;
  const host = config.server;
  const useTls = Boolean(config.ssl || config.tls);
  const port = Number(config.port || (useTls ? 6697 : 6667));
  const requestedNick = config.nick;
  const username = config.username || requestedNick;
  const realname = config.realname || "Codex IRC Bot";
  const channels = (config.channels || []).filter(Boolean);
  const maxMessageLength = Number(config.maxMessageLength || 380);
  const connectTimeoutMs = Number(config.connectTimeoutMs || 15000);
  const saslEnabled =
    Boolean(config.sasl?.enabled) || Boolean(config.sasl?.username) || Boolean(config.sasl?.password);
  const saslUsername = config.sasl?.username || username;
  const saslPassword = config.sasl?.password || "";
  let currentNick = requestedNick;

  const historyByConversation = new Map();
  const queueByConversation = new Map();

  let socket = null;
  let socketBuffer = "";
  let stopRequested = false;
  let joinedChannels = false;
  let readySettled = false;
  let capEnded = !saslEnabled;
  let capLsBuffer = "";
  let saslAuthStarted = false;
  let saslChunks = [];

  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const readyTimeout = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      readyReject(new Error(`IRC connect timeout after ${connectTimeoutMs}ms`));
    }
  }, connectTimeoutMs);

  function resolveReady() {
    if (readySettled) {
      return;
    }
    readySettled = true;
    clearTimeout(readyTimeout);
    readyResolve();
  }

  function rejectReady(error) {
    if (readySettled) {
      return;
    }
    readySettled = true;
    clearTimeout(readyTimeout);
    readyReject(error);
  }

  function closeWithError(message) {
    rejectReady(new Error(message));
    if (!socket || socket.destroyed) {
      return;
    }

    sendRaw(`QUIT :${message}`);
    socket.end();
  }

  function endCapNegotiation() {
    if (capEnded) {
      return;
    }

    capEnded = true;
    sendRaw("CAP END");
  }

  function sendRaw(line) {
    if (!socket || socket.destroyed) {
      return;
    }
    socket.write(`${line}\r\n`);
  }

  function sendMessage(target, text) {
    const normalized = text.replace(/\r?\n/g, " ").trim();
    if (!normalized) {
      return;
    }

    for (const chunk of splitIrcMessage(normalized, maxMessageLength)) {
      sendRaw(`PRIVMSG ${target} :${chunk}`);
    }
  }

  function appendHistory(key, message) {
    const history = historyByConversation.get(key) || [];
    history.push(message);

    if (history.length > maxThreadHistory) {
      history.splice(0, history.length - maxThreadHistory);
    }

    historyByConversation.set(key, history);
  }

  function getHistory(key) {
    return [...(historyByConversation.get(key) || [])];
  }

  function enqueueConversation(key, task) {
    const previous = queueByConversation.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    queueByConversation.set(key, next);

    next.finally(() => {
      if (queueByConversation.get(key) === next) {
        queueByConversation.delete(key);
      }
    });

    return next;
  }

  function handlePrivmsg(parsed) {
    const senderNick = extractNick(parsed.prefix || "");
    const target = parsed.params[0];
    const messageText = parsed.params[1] || "";

    if (!senderNick || !target) {
      return;
    }

    if (senderNick.toLowerCase() === currentNick.toLowerCase()) {
      return;
    }

    const isDirect = target.toLowerCase() === currentNick.toLowerCase();
    if (!isDirect && !isMentioningBot(messageText, currentNick)) {
      return;
    }

    const cleanedText = isDirect ? messageText.trim() : stripBotMention(messageText, currentNick);
    if (!cleanedText) {
      return;
    }

    const conversationKey = isDirect
      ? `irc:dm:${senderNick.toLowerCase()}`
      : `irc:channel:${target.toLowerCase()}`;
    const replyTarget = isDirect ? senderNick : target;

    void enqueueConversation(conversationKey, async () => {
      const userContent = isDirect ? cleanedText : `${senderNick}: ${cleanedText}`;
      const context = [...getHistory(conversationKey), { role: "user", content: userContent }];

      try {
        const answer =
          (await createAiResponse(context, {
            model: config.model,
            webSearch: config.webSearch,
            systemPrompt: config.systemPrompt
          })) || "응답을 생성하지 못했어요.";

        appendHistory(conversationKey, { role: "user", content: userContent });
        appendHistory(conversationKey, { role: "assistant", content: answer });
        sendMessage(replyTarget, answer);
      } catch (error) {
        console.error(`[irc][message] error name=${config.name} target=${replyTarget}`, error);
        sendMessage(replyTarget, "에러가 발생했습니다. 잠시 후 다시 시도해주세요.");
      }
    });
  }

  function handleIrcLine(rawLine) {
    const parsed = parseIrcLine(rawLine);
    if (!parsed) {
      return;
    }

    if (parsed.command === "PING") {
      sendRaw(`PONG :${parsed.params[0] || ""}`);
      return;
    }

    if (parsed.command === "001") {
      endCapNegotiation();
      if (!joinedChannels) {
        joinedChannels = true;
        for (const channel of channels) {
          sendRaw(`JOIN ${channel}`);
        }
      }
      resolveReady();
      return;
    }

    if (parsed.command === "433") {
      currentNick = `${requestedNick}_${Math.floor(Math.random() * 1000)}`;
      sendRaw(`NICK ${currentNick}`);
      return;
    }

    if (parsed.command === "CAP") {
      const subCommand = (parsed.params[1] || "").toUpperCase();
      const hasMore = parsed.params[2] === "*";
      const capabilityList = hasMore ? parsed.params[3] || "" : parsed.params[2] || "";

      if (subCommand === "LS") {
        capLsBuffer = `${capLsBuffer} ${capabilityList}`.trim();
        if (hasMore) {
          return;
        }

        if (!saslEnabled) {
          endCapNegotiation();
          capLsBuffer = "";
          return;
        }

        const saslSupported = hasCapability(capLsBuffer, "sasl");
        capLsBuffer = "";
        if (!saslSupported) {
          closeWithError(`IRC server does not support SASL for name=${config.name}`);
          return;
        }

        sendRaw("CAP REQ :sasl");
        return;
      }

      if (subCommand === "ACK") {
        if (!saslEnabled || !hasCapability(capabilityList, "sasl")) {
          endCapNegotiation();
          return;
        }

        saslAuthStarted = true;
        sendRaw("AUTHENTICATE PLAIN");
        return;
      }

      if (subCommand === "NAK" && saslEnabled) {
        closeWithError(`IRC server rejected SASL capability for name=${config.name}`);
        return;
      }

      return;
    }

    if (parsed.command === "AUTHENTICATE" && saslAuthStarted) {
      if ((parsed.params[0] || "") !== "+") {
        return;
      }

      if (!saslChunks.length) {
        saslChunks = buildSaslPlainChunks(saslUsername, saslPassword);
      }

      const chunk = saslChunks.shift();
      if (chunk) {
        sendRaw(`AUTHENTICATE ${chunk}`);
      }
      return;
    }

    if (parsed.command === "903") {
      endCapNegotiation();
      return;
    }

    if (["904", "905", "906", "907", "908"].includes(parsed.command)) {
      const detail = parsed.params[parsed.params.length - 1] || "SASL authentication failed";
      closeWithError(`IRC SASL failed: ${detail}`);
      return;
    }

    if (parsed.command === "NICK") {
      const oldNick = extractNick(parsed.prefix || "");
      const nextNick = parsed.params[0];
      if (oldNick && nextNick && oldNick.toLowerCase() === currentNick.toLowerCase()) {
        currentNick = nextNick;
      }
      return;
    }

    if (parsed.command === "ERROR") {
      const detail = parsed.params[0] || "server error";
      rejectReady(new Error(`IRC server error: ${detail}`));
      return;
    }

    if (parsed.command === "PRIVMSG") {
      handlePrivmsg(parsed);
    }
  }

  socket = useTls
    ? tls.connect({
        host,
        port,
        servername: host
      })
    : net.createConnection({
        host,
        port
      });

  socket.setEncoding("utf8");

  socket.on("connect", () => {
    if (config.password) {
      sendRaw(`PASS ${config.password}`);
    }

    if (saslEnabled) {
      sendRaw("CAP LS 302");
    }

    sendRaw(`NICK ${currentNick}`);
    sendRaw(`USER ${username} 0 * :${realname}`);
  });

  socket.on("data", (chunk) => {
    socketBuffer += chunk;

    while (true) {
      const newlineIndex = socketBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const line = socketBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      socketBuffer = socketBuffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      handleIrcLine(line);
    }
  });

  socket.on("error", (error) => {
    console.error(`[irc][socket_error] name=${config.name}`, error);
    rejectReady(error);
  });

  socket.on("close", () => {
    if (stopRequested) {
      return;
    }

    if (!readySettled) {
      rejectReady(new Error("IRC connection closed before ready"));
      return;
    }

    console.error(`[irc] connection closed unexpectedly name=${config.name}`);
    process.exit(1);
  });

  await readyPromise;

  console.log(
    `[irc] started name=${config.name} server=${host}:${port} ssl=${useTls} sasl=${saslEnabled} nick=${currentNick} channels=${channels.length} model=${config.model || "default"} web_search=${config.webSearch} system_prompt=${config.systemPrompt ? "service" : "default"}`
  );

  return {
    async stop() {
      if (stopRequested) {
        return;
      }
      stopRequested = true;

      if (!socket || socket.destroyed) {
        return;
      }

      await new Promise((resolve) => {
        let settled = false;

        const finish = () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve();
        };

        socket.once("close", finish);
        sendRaw("QUIT :shutting down");
        socket.end();

        setTimeout(() => {
          if (socket && !socket.destroyed) {
            socket.destroy();
          }
          finish();
        }, 2000);
      });

      console.log(`[irc] stopped name=${config.name}`);
    }
  };
}
