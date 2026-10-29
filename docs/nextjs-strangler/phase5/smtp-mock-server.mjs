// Mock SMTP sink for R5e parity38 (eNom-mock precedent: a small Node
// script on a fixed port, capturing full messages for comparison).
//
// Listens on 127.0.0.1:18025 (argv[2] overrides the port, argv[3]
// overrides the capture file). Plain SMTP only: EHLO advertises AUTH
// PLAIN LOGIN and 8BITMIME, deliberately NOT STARTTLS, so both PHP
// Symfony Mailer (smtp:// DSN, opportunistic STARTTLS) and nodemailer
// (secure:false, opportunistic STARTTLS) stay on a plain connection
// and the captured conversations are comparable.
//
// Failure scripting is by recipient-address pattern (deterministic,
// no control channel needed):
//   *fail@*   -> 550 at RCPT TO, every time (permanent reject).
//   *flaky@*  -> 451 at DATA the first time, 250 afterwards (transient).
//   *drop@*   -> socket destroyed after DATA (connection drop).
// Everything else -> 250 + message recorded.
//
// SECURITY: AUTH credentials are NEVER written to the capture file.
// Only the mechanism (PLAIN/LOGIN) and a boolean are recorded. The
// suite uses dummy credentials anyway; the mock must not become a
// secret store even for those.
//
// Capture file: JSONL, one object per accepted message or rejected
// attempt, appended with O_APPEND (the suite may truncate between
// sections; appends land after the truncation point). Fields:
//   { type: 'accepted'|'rejected', ts, mailFrom, rcptTo[], auth,
//     stage, code, data? } — data present only for accepted messages.

import net from "node:net";
import fs from "node:fs";

const PORT = parseInt(process.argv[2] ?? "18025", 10);
const CAPTURE = process.argv[3] ?? "/home/hatch/scratch/fossbilling/r5-logs/smtp-mock.jsonl";

const flakySeen = new Set();

function record(obj) {
  fs.appendFileSync(CAPTURE, JSON.stringify(obj) + "\n");
}

function parseAddress(cmd) {
  const m = cmd.match(/:\s*<([^>]*)>/);
  return m ? m[1] : "";
}

const server = net.createServer((socket) => {
  socket.write("220 mock ESMTP ready\r\n");
  let mailFrom = "";
  let rcptTo = [];
  let auth = null;
  let dataMode = false;
  let dataBuf = "";
  let buf = "";

  function resetTx() {
    mailFrom = "";
    rcptTo = [];
    auth = null;
  }

  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    // DATA mode consumes until <CRLF>.<CRLF>.
    while (true) {
      if (dataMode) {
        const end = buf.indexOf("\r\n.\r\n");
        if (end === -1) {
          // Tolerate a lone trailing "\n.\n" only if the client sent it;
          // real clients (Symfony, nodemailer) use CRLF.
          return;
        }
        const raw = buf.slice(0, end);
        buf = buf.slice(end + 5);
        dataMode = false;
        const data = raw.replace(/\r\n\.\./g, "\r\n.");
        const rcpt = rcptTo[0] ?? "";
        if (rcpt.includes("drop@")) {
          record({ type: "rejected", ts: new Date().toISOString(), mailFrom, rcptTo, auth, stage: "DATA", code: "drop" });
          socket.destroy();
          return;
        }
        if (rcpt.includes("flaky@") && !flakySeen.has(rcpt)) {
          flakySeen.add(rcpt);
          record({ type: "rejected", ts: new Date().toISOString(), mailFrom, rcptTo, auth, stage: "DATA", code: 451 });
          socket.write("451 try again later\r\n");
          continue;
        }
        record({ type: "accepted", ts: new Date().toISOString(), mailFrom, rcptTo, auth, data });
        socket.write("250 OK\r\n");
        continue;
      }
      const eol = buf.indexOf("\r\n");
      if (eol === -1) return;
      const line = buf.slice(0, eol);
      buf = buf.slice(eol + 2);
      const cmd = line.split(" ")[0].toUpperCase();
      if (cmd === "EHLO" || cmd === "HELO") {
        socket.write("250-mock\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
      } else if (cmd === "MAIL") {
        mailFrom = parseAddress(line);
        socket.write("250 OK\r\n");
      } else if (cmd === "RCPT") {
        const rcpt = parseAddress(line);
        if (rcpt.includes("fail@")) {
          record({ type: "rejected", ts: new Date().toISOString(), mailFrom, rcptTo: [rcpt], auth, stage: "RCPT", code: 550 });
          socket.write("550 no such mailbox\r\n");
        } else {
          rcptTo.push(rcpt);
          socket.write("250 OK\r\n");
        }
      } else if (cmd === "DATA") {
        if (rcptTo.length === 0) {
          socket.write("503 no recipients\r\n");
        } else {
          dataMode = true;
          dataBuf = "";
          socket.write("354 end data with <CR><LF>.<CR><LF>\r\n");
        }
      } else if (cmd === "RSET") {
        resetTx();
        socket.write("250 OK\r\n");
      } else if (cmd === "NOOP") {
        socket.write("250 OK\r\n");
      } else if (cmd === "AUTH") {
        // Record the mechanism only — never the credential.
        const mech = (line.split(" ")[1] ?? "").toUpperCase();
        auth = mech === "PLAIN" || mech === "LOGIN" ? mech : "OTHER";
        // Accept unconditionally; AUTH LOGIN exchanges extra round
        // trips (334 prompts) that the mock answers generically.
        if (mech === "LOGIN") {
          // Prompt flow (nodemailer/Symfony default): 334 username,
          // then 334 password, then 235. Inline form (AUTH LOGIN
          // <base64user>) skips straight to the password prompt.
          const parts = line.split(" ");
          if (parts.length >= 3 && parts[2]) {
            auth = "LOGIN-PENDING-PASS";
            socket.write("334 UGFzc3dvcmQ6\r\n");
          } else {
            auth = "LOGIN-PENDING-USER";
            socket.write("334 VXNlcm5hbWU6\r\n");
          }
        } else {
          socket.write("235 OK\r\n");
        }
      } else if (auth === "LOGIN-PENDING-USER") {
        auth = "LOGIN-PENDING-PASS";
        socket.write("334 UGFzc3dvcmQ6\r\n");
      } else if (auth === "LOGIN-PENDING-PASS") {
        auth = "LOGIN";
        socket.write("235 OK\r\n");
      } else if (cmd === "QUIT") {
        socket.write("221 bye\r\n");
        socket.end();
      } else if (cmd === "STARTTLS") {
        socket.write("502 not supported\r\n");
      } else {
        socket.write("502 unknown command\r\n");
      }
    }
  });
  socket.on("error", () => {});
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock smtp listening on 127.0.0.1:${PORT}, capture ${CAPTURE}`);
});
