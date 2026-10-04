import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { Duplex } from "node:stream";
import { setImmediate } from "node:timers/promises";

import { startIrcBot } from "../src/connectors/irc.js";

for (const secure of [false, true]) {
  test(`IRC ${secure ? "TLS/SASL" : "TCP"} reconnects without losing history and stops cleanly`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    t.mock.method(console, "log", () => {});
    t.mock.method(console, "error", () => {});
    const sockets = [];
    t.mock.method(secure ? tls : net, secure ? "connect" : "createConnection", () => {
      const writes = [];
      const socket = new Duplex({
        allowHalfOpen: false,
        read() {},
        write(chunk, encoding, callback) {
          writes.push(chunk.toString().replace(/\r\n$/, ""));
          callback();
        },
        final(callback) {
          this.push(null);
          callback();
        }
      });
      sockets.push({ socket, writes });
      return socket;
    });

    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    t.after(() => {
      if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = originalKey;
    });
    const requests = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(url, "https://api.anthropic.com/v1/messages");
      requests.push(JSON.parse(options.body));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ content: [{ type: "text", text: `answer-${requests.length}` }] })
      };
    });

    let runtime;
    t.after(async () => {
      await runtime?.stop();
      for (const { socket } of sockets) socket.destroy();
      await setImmediate();
    });
    const starting = startIrcBot({
      name: "test",
      server: "irc.test",
      ssl: secure,
      nick: "bot",
      channels: ["#test"],
      password: "server-password",
      sasl: secure ? { enabled: true, username: "account", password: "password" } : undefined,
      models: ["test-model"],
      providers: { anthropic: { models: ["test-model"] } },
      connectTimeoutMs: 50
    }, { maxContextBytes: 200_000 });
    let started = false;
    starting.then(() => { started = true; });

    // An initial network failure and a registration timeout both retry.
    sockets[0].socket.destroy(new Error("ECONNREFUSED"));
    await setImmediate();
    t.mock.timers.tick(999);
    assert.equal(sockets.length, 1);
    t.mock.timers.tick(1);
    sockets[1].socket.emit("connect");
    t.mock.timers.tick(50);
    await setImmediate();
    assert.equal(sockets[1].socket.destroyed, true);
    t.mock.timers.tick(1999);
    assert.equal(sockets.length, 2);
    t.mock.timers.tick(1);

    for (const delay of [4000, 8000, 16000, 30000, 30000]) {
      const attempts = sockets.length;
      sockets.at(-1).socket.destroy(new Error("ECONNREFUSED"));
      await setImmediate();
      t.mock.timers.tick(delay - 1);
      assert.equal(sockets.length, attempts);
      t.mock.timers.tick(1);
      assert.equal(sockets.length, attempts + 1);
    }

    if (secure) {
      sockets.at(-1).socket.emit("connect");
      sockets.at(-1).socket.push(":server CAP bot LS :sasl\r\n:server CAP bot ACK :sasl\r\nAUTHENTICATE +\r\n:server 904 bot :Authentication failed\r\n:server 001 bot :Welcome\r\n");
      await setImmediate();
      assert.equal(sockets.at(-1).socket.destroyed, true);
      assert.equal(started, false, "failed SASL must not continue to registration");
      t.mock.timers.tick(30_000);
    }

    async function register({ socket, writes }) {
      socket.emit("connect");
      if (secure) {
        socket.push(":server CAP bot LS :sasl\r\n:server CAP bot ACK :sasl\r\nAUTHENTICATE +\r\n:server 903 bot :Authenticated\r\n");
      }
      socket.push(":server 001 bot :Welcome\r\n");
      await setImmediate();
      assert.deepEqual(writes, [
        "PASS server-password",
        ...(secure ? ["CAP LS 302"] : []),
        "NICK bot",
        "USER bot 0 * :Codex IRC Bot",
        ...(secure ? [
          "CAP REQ :sasl", "AUTHENTICATE PLAIN",
          `AUTHENTICATE ${Buffer.from("\0account\0password").toString("base64")}`, "CAP END"
        ] : []),
        "JOIN #test"
      ]);
    }

    await register(sockets.at(-1));
    runtime = await starting;
    sockets.at(-1).socket.push(":alice!user@host PRIVMSG bot :question-before\r\n");
    await setImmediate();
    assert.equal(sockets.at(-1).writes.at(-1), "PRIVMSG alice :answer-1");

    // Discard old connection state, but retain conversation history.
    sockets.at(-1).socket.push(":bot!user@host NICK :old-nick\r\n:unfinished-line");
    await setImmediate();
    sockets.at(-1).socket.push(null);
    await setImmediate();
    const attempts = sockets.length;
    t.mock.timers.tick(999);
    assert.equal(sockets.length, attempts);
    t.mock.timers.tick(1);
    assert.equal(sockets.length, attempts + 1, "successful registration resets the retry delay");
    await register(sockets.at(-1));
    sockets.at(-1).socket.push(":alice!user@host PRIVMSG bot :question-after\r\n");
    await setImmediate();
    assert.equal(sockets.at(-1).writes.at(-1), "PRIVMSG alice :answer-2");
    assert.equal(requests.length, 2);
    const context = JSON.stringify(requests[1].messages);
    assert.match(context, /question-before/);
    assert.match(context, /answer-1/);
    assert.match(context, /question-after/);

    sockets.at(-1).socket.push("ERROR :Server restarting\r\n");
    await setImmediate();
    assert.equal(sockets.at(-1).socket.destroyed, true);
    if (secure) t.mock.timers.tick(1000);
    // Stop both during backoff (TCP) and during a new connection attempt (TLS).
    const attemptsAtStop = sockets.length;
    await runtime.stop();
    t.mock.timers.tick(60_000);
    await setImmediate();
    assert.equal(sockets.length, attemptsAtStop);
    assert.equal(sockets.at(-1).socket.destroyed, true);
    if (secure) assert.equal(sockets.at(-1).writes.at(-1), "QUIT :shutting down");
  });
}
