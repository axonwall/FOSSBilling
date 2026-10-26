// Fixture-XML mock of eNom's interface.asp for the TS eNom client.
// Serves canned XML per command and logs every request (query params)
// to stdout as JSON lines, so the smoke test can assert exactly which
// commands the TS client sent. No eNom credentials or network needed.
//
//   node enom-mock-server.mjs [port]   (default 18099)
//
// Fixture domain: example.com (registered, unlocked, expires
// 2027-03-15); taken.com is registered+locked; free-domain-xyz.com is
// available. Any other SLD behaves like example.com. uid/pw are
// accepted as-is; uid=baduser returns ErrCount=1 (auth failure).
//
// Error injection: SLD "boom" returns ErrCount=1 "Simulated eNom
// failure" for every command, exercising the client's error path.

import http from "node:http";
import fs from "node:fs";

const PORT = Number(process.argv[2] ?? 18099);
const LOG = process.env.ENOM_MOCK_LOG;

const xml = (body) => `<?xml version="1.0" encoding="utf-8"?>\n<interface-response>\n${body}\n<ErrCount>0</ErrCount>\n<Done>true</Done>\n</interface-response>`;

function handler(req, res) {
  const u = new URL(req.url, "http://mock");
  const q = Object.fromEntries(u.searchParams.entries());
  const line = JSON.stringify({ command: q.command, params: q });
  console.log(line);
  if (LOG) fs.appendFileSync(LOG, line + "\n");
  const sld = (q.sld ?? q.sld1 ?? "").toLowerCase();
  const send = (body) => {
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(xml(body));
  };
  const err = (msg) => {
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(
      `<?xml version="1.0" encoding="utf-8"?>\n<interface-response>\n<ErrCount>1</ErrCount>\n<Err1>${msg}</Err1>\n<Done>true</Done>\n</interface-response>`,
    );
  };
  if (q.uid === "baduser") return err("Invalid login");
  if (sld === "boom") return err("Simulated eNom failure");
  const locked = sld === "taken";
  switch ((q.command ?? "").toLowerCase()) {
    case "check": {
      const available = sld === "free-domain-xyz";
      return send(
        `<DomainName>${sld}.${q.tld}</DomainName>\n<RRPCode>${available ? 210 : 211}</RRPCode>\n<RRPText>Domain ${available ? "available" : "not available"}</RRPText>`,
      );
    }
    case "getreglock":
      return send(`<RegLock>${locked ? 1 : 0}</RegLock>`);
    case "setreglock":
      return send(`<RegLock>${q.UnlockRegistrar === "0" ? 1 : 0}</RegLock>`);
    case "getdomaininfo":
      return send(
        `<SLD>${sld}</SLD>\n<TLD>${q.tld}</TLD>\n<DomainNameID>4242</DomainNameID>\n<Expiration>2027-03-15</Expiration>\n<RegistrationStatus>Registered</RegistrationStatus>`,
      );
    case "getdns":
      return send(`<NSCount>2</NSCount>\n<DNS1>ns1.mock.example</DNS1>\n<DNS2>ns2.mock.example</DNS2>`);
    case "getcontacts":
      return send(
        [
          "RegistrantFirstName>Mock",
          "RegistrantLastName>Registrant",
          "RegistrantOrganizationName>Mock Org",
          "RegistrantAddress1>1 Mock Way",
          "RegistrantAddress2>Apt 2",
          "RegistrantCity>Mockville",
          "RegistrantStateProvince>TX",
          "RegistrantPostalCode>78701",
          "RegistrantCountry>US",
          "RegistrantEmailAddress>reg@mock.example",
          "RegistrantPhone>+1.5550100",
        ]
          .map((f) => `<${f}</${f.split(">")[0]}>`)
          .join("\n"),
      );
    case "modifyns":
      return send(`<RRPText>Nameservers updated</RRPText>`);
    case "contacts":
      return send(`<RRPText>Contacts updated</RRPText>`);
    case "synchauthinfo":
      return send(`<EPPEmailMessage>Auth code emailed</EPPEmailMessage>`);
    case "purchase":
      return send(`<RRPCode>200</RRPCode>\n<RRPText>Domain registered</RRPText>`);
    case "tp_createorder":
      return send(`<success>True</success>\n<statusdesc1>Transfer submitted</statusdesc1>`);
    case "extend":
      return send(`<RRPText>Domain extended</RRPText>`);
    case "addtocart":
      return send(`<CartID>99</CartID>`);
    case "insertneworder":
      return send(`<OrderID>100</OrderID>`);
    default:
      return err(`Unknown mock command ${q.command}`);
  }
}

http.createServer(handler).listen(PORT, "127.0.0.1", () => {
  console.log(JSON.stringify({ listening: PORT }));
});
