/* ============================================================
   SESSIE-SERVER — bewaart en serveert scene-sessies
   ============================================================
   Losstaand van ur5-bridge.js en plc-bridge.js: een sessie is het
   scherm-onafhankelijke bestand dat beschrijft welke componenten
   (robots, cilinders, sensoren, tafels, ...) in de scene staan, hoe
   ze bewegen (gewrichten) en aan welk digitaal signaal (robot- of
   PLC-bridge) dat gekoppeld is.

   De simulator (Digital Twin Builder / UR5-twin) bewaart hier de
   sessie die je aan het bouwen bent. De AR-viewer haalt daar
   automatisch de ACTIEVE sessie op — geen handmatige bestands-
   overdracht naar de HoloLens — en blijft verbonden via WebSocket,
   zodat een wijziging in de simulator meteen ook in de AR-bril
   verschijnt.

   SESSIE-BESTANDSFORMAAT (v1) — zie ook voorbeeld-sessie.json
     {
       "versie": 1,
       "naam": "...", "aangemaakt": ISO-datum, "gewijzigd": ISO-datum,

       "bronnen": [                              // de bridges die dit signalen leveren
         { "id": "robot1", "type": "robot-bridge", "wsUrl": "ws://localhost:9090" },
         { "id": "plc1",   "type": "plc-bridge",   "wsUrl": "ws://localhost:9190" }
       ],

       "componenten": [
         {
           "id": "ur5e-1", "naam": "UR5e", "soort": "robot",
           "bron": "robot1",                     // alleen bij soort "robot"
           "positie": {"x":0,"y":0,"z":0}, "rotatieGraden": {"x":0,"y":0,"z":0}
           // een robot-component heeft geen eigen "ledematen" hier — die
           // kinematica komt uit de bestaande UR5-DH-code, niet uit de sessie.
         },
         {
           "id": "cilinder-1", "naam": "Pneumatische cilinder 1", "soort": "onderdeel",
           "model": { "type": "step", "bestand": "cilinder-1.step" },
           "positie": {"x":1.2,"y":0,"z":0.5}, "rotatieGraden": {"x":0,"y":0,"z":0},
           "ledematen": [
             {
               "id": "stang", "naam": "Cilinderstang", "ouder": null,
               "gewricht": {
                 "type": "prismatic",             // of "revolute"
                 "as": {"x":0,"y":0,"z":1}, "pivot": {"x":0,"y":0,"z":0},
                 "min": 0, "max": 50, "eenheid": "mm", "waarde": 0
               },
               "io": { "bron": "plc1", "signaal": "motorVrijgave", "schrijfbaar": false }
             }
           ],
           "indicatoren": [
             { "id": "sensor-1", "naam": "Sensor 1 (ingetrokken)",
               "positie": {"x":0,"y":0,"z":0},
               "io": { "bron": "plc1", "signaal": "sensorIngetrokken" } }
           ]
         }
       ]
     }

   "ouder" bij een ledemaat verwijst naar het id van het vorige ledemaat
   in de keten (null = vastzittend aan de basis van het component) —
   zo kun je ook een meerdelige keten (zoals een eigen 6-assige arm)
   in één component opbouwen, niet alleen een los onderdeel.

   "schrijfbaar" bij een io-koppeling: false (standaard) betekent dat
   het gewricht/de indicator het signaal alleen VOLGT (visualisatie);
   true betekent dat de gebruiker het gewricht in de twin/AR mag
   bedienen, en dat de nieuwe stand als schrijfcommando naar de bridge
   gaat — zelfde onderscheid als "schrijfbaar" in plc-bridge.js.

   INSTALLATIE
     npm install ws
     node session-server.js
     Standaard op poort 9290 (HTTP + WebSocket samen, één poort).
     Aanpasbaar via de omgevingsvariabele POORT. Sessies worden als
     losse .json-bestanden bewaard in de map "sessies" naast dit
     script (wordt bij de eerste start automatisch aangemaakt).

   HTTP-API (CORS staat open, zodat de simulator/AR-pagina's — die op
   een ander origin draaien — hier gewoon bij kunnen)
     GET    /sessies              -> lijst [{id, naam, gewijzigd}]
     GET    /sessies/:id          -> volledige sessie-JSON
     PUT    /sessies/:id          -> sessie opslaan/overschrijven (body = sessie-JSON)
     DELETE /sessies/:id          -> sessie verwijderen
     GET    /actief               -> { id: "..." | null }
     PUT    /actief               -> body { id } zet de actieve sessie

   WEBSOCKET (zelfde poort, pad "/")
     Elke client krijgt bij verbinden meteen { type:"actief", id }.
     Na elke wijziging (opslaan/verwijderen/actief zetten) stuurt de
     server { type:"sessieGewijzigd", id } naar alle verbonden clients
     — de AR-viewer en de simulator verversen zichzelf daarop.
   ============================================================ */

const fs = require("fs");
const http = require("http");
const path = require("path");
const https = require("https");
const WebSocket = require("ws");

const POORT = +(process.env.POORT || 9290);
const SESSIES_MAP = path.join(__dirname, "sessies");
const ACTIEF_BESTAND = path.join(SESSIES_MAP, "_actief.json");

if (!fs.existsSync(SESSIES_MAP)) fs.mkdirSync(SESSIES_MAP);

/* Een sessie-id mag alleen letters, cijfers, - en _ bevatten — dat
   voorkomt pad-trucjes (zoals "../../wachtwoorden") via de URL.    */
function geldigId(id) {
  return typeof id === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
}
function sessiePad(id) { return path.join(SESSIES_MAP, id + ".json"); }

function leesActief() {
  try { return JSON.parse(fs.readFileSync(ACTIEF_BESTAND, "utf8")).id; }
  catch { return null; }
}
function schrijfActief(id) {
  fs.writeFileSync(ACTIEF_BESTAND, JSON.stringify({ id }));
}

function leesBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
      if (data.length > 20 * 1024 * 1024) { req.destroy(); reject(new Error("body te groot")); }
    });
    req.on("end", () => {
      if (!data) return resolve(undefined);
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error("ongeldige JSON")); }
    });
    req.on("error", reject);
  });
}

function stuurJSON(res, statuscode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statuscode, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Private-Network": "true",     // een https-pagina op internet mag deze server op het eigen netwerk bereiken
  });
  res.end(body);
}

let wss;
function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

/* ---------- AR-sessies in de buurt ----------
   De bridges melden zich hier elke 5 seconden aan (POST /ar-sessies/aanmelden).
   De AR-pagina vraagt de lijst op (GET /ar-sessies). Een sessie die 15 seconden
   niets laat horen, verdwijnt uit de lijst.                                    */
const arSessies = new Map();   // id -> {id, naam, wsUrl, robot, deelnemers, gezien}
function arLijst() {
  const nu = Date.now();
  for (const [id, s] of arSessies) if (nu - s.gezien > 15000) arSessies.delete(id);
  return [...arSessies.values()].map(({ gezien, ...rest }) => rest);
}

const handler = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${POORT}`);
  const delen = url.pathname.split("/").filter(Boolean);   // bv ["sessies", "cel-1"]

  if (req.method === "OPTIONS") { stuurJSON(res, 204, {}); return; }

  try {
    /* ---------- AR-sessies in de buurt ---------- */
    if (req.method === "GET" && delen.length === 1 && delen[0] === "ar-sessies") { stuurJSON(res, 200, arLijst()); return; }
    if (req.method === "POST" && delen.length === 2 && delen[0] === "ar-sessies" && delen[1] === "afmelden") {   // de bridge stopt: meteen uit de lijst
      const b = await leesBody(req);
      if (b && arSessies.delete(String(b.id))) console.log(`[ar] sessie afgemeld: ${b.id}`);
      stuurJSON(res, 200, { ok: true }); return;
    }
    if (req.method === "POST" && delen.length === 2 && delen[0] === "ar-sessies" && delen[1] === "aanmelden") {
      const b = await leesBody(req);
      if (!b || typeof b.id !== "string" || typeof b.wsUrl !== "string" || !/^wss?:\/\//.test(b.wsUrl)) { stuurJSON(res, 400, { fout: "id en wsUrl (ws:// of wss://) zijn verplicht" }); return; }
      const bestond = arSessies.has(b.id);
      arSessies.set(b.id, {
        id: String(b.id).slice(0, 100), naam: String(b.naam || b.id).slice(0, 80), wsUrl: b.wsUrl.slice(0, 200),
        robot: String(b.robot || "").slice(0, 40),
        host: String(b.host || "").slice(0, 24),
        deelnemers: Array.isArray(b.deelnemers) ? b.deelnemers.slice(0, 20).map(n => String(n).slice(0, 24)) : [],
        gezien: Date.now(),
      });
      if (!bestond) console.log(`[ar] sessie aangemeld: ${b.naam || b.id} (${b.wsUrl})`);
      stuurJSON(res, 200, { ok: true });
      return;
    }

    /* ---------- GET /sessies ---------- */
    if (req.method === "GET" && delen.length === 1 && delen[0] === "sessies") {
      const lijst = fs.readdirSync(SESSIES_MAP)
        .filter(f => f.endsWith(".json") && f !== "_actief.json")
        .map(f => {
          const sessie = JSON.parse(fs.readFileSync(path.join(SESSIES_MAP, f), "utf8"));
          return { id: f.replace(/\.json$/, ""), naam: sessie.naam || f, gewijzigd: sessie.gewijzigd || null };
        });
      stuurJSON(res, 200, lijst);
      return;
    }

    /* ---------- GET /actief ---------- */
    if (req.method === "GET" && delen.length === 1 && delen[0] === "actief") {
      stuurJSON(res, 200, { id: leesActief() });
      return;
    }

    /* ---------- PUT /actief ---------- */
    if (req.method === "PUT" && delen.length === 1 && delen[0] === "actief") {
      const body = await leesBody(req);
      if (!body || !geldigId(body.id)) { stuurJSON(res, 400, { fout: "ongeldig of ontbrekend id" }); return; }
      if (!fs.existsSync(sessiePad(body.id))) { stuurJSON(res, 404, { fout: "sessie bestaat niet: " + body.id }); return; }
      schrijfActief(body.id);
      console.log(`[sessie] actieve sessie gezet op "${body.id}"`);
      broadcast({ type: "sessieGewijzigd", id: body.id });
      stuurJSON(res, 200, { id: body.id });
      return;
    }

    /* ---------- /sessies/:id ---------- */
    if (delen.length === 2 && delen[0] === "sessies") {
      const id = delen[1];
      if (!geldigId(id)) { stuurJSON(res, 400, { fout: "ongeldig sessie-id" }); return; }
      const pad = sessiePad(id);

      if (req.method === "GET") {
        if (!fs.existsSync(pad)) { stuurJSON(res, 404, { fout: "sessie niet gevonden: " + id }); return; }
        stuurJSON(res, 200, JSON.parse(fs.readFileSync(pad, "utf8")));
        return;
      }

      if (req.method === "PUT") {
        const sessie = await leesBody(req);
        if (!sessie || typeof sessie !== "object") { stuurJSON(res, 400, { fout: "body moet de sessie-JSON zijn" }); return; }
        sessie.versie = sessie.versie || 1;
        sessie.aangemaakt = sessie.aangemaakt || (fs.existsSync(pad) ? JSON.parse(fs.readFileSync(pad, "utf8")).aangemaakt : new Date().toISOString());
        sessie.gewijzigd = new Date().toISOString();
        fs.writeFileSync(pad, JSON.stringify(sessie, null, 2));
        console.log(`[sessie] "${id}" opgeslagen (${(sessie.componenten || []).length} componenten)`);
        broadcast({ type: "sessieGewijzigd", id });
        stuurJSON(res, 200, sessie);
        return;
      }

      if (req.method === "DELETE") {
        if (!fs.existsSync(pad)) { stuurJSON(res, 404, { fout: "sessie niet gevonden: " + id }); return; }
        fs.unlinkSync(pad);
        console.log(`[sessie] "${id}" verwijderd`);
        if (leesActief() === id) schrijfActief(null);
        broadcast({ type: "sessieGewijzigd", id: leesActief() });
        stuurJSON(res, 200, { verwijderd: id });
        return;
      }
    }

    stuurJSON(res, 404, { fout: "onbekend pad: " + req.method + " " + url.pathname });
  } catch (err) {
    console.log(`[sessie] serverfout bij ${req.method} ${url.pathname}: ${err.message}`);
    stuurJSON(res, 500, { fout: err.message });
  }
};

/* Met cert.pem en key.pem naast dit bestand (zelfde als bij ur5-bridge.js) draait deze server ook over https,
   nodig als de AR-pagina zelf via https wordt geopend (bijv. digitaltwin.devops.it). */
const zoek = naam => [path.join(__dirname, naam), path.join(process.cwd(), naam), path.join(__dirname, "bridge", naam)].find(f => fs.existsSync(f)) || path.join(__dirname, naam);
const CERT = process.env.TLS_CERT || zoek("cert.pem");
const KEY  = process.env.TLS_KEY  || zoek("key.pem");
const server = (fs.existsSync(CERT) && fs.existsSync(KEY))
  ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler)
  : http.createServer(handler);
wss = new WebSocket.Server({ server });
wss.on("connection", ws => {
  console.log("[sessie/webapp] verbonden");
  ws.send(JSON.stringify({ type: "actief", id: leesActief() }));
  ws.on("close", () => console.log("[sessie/webapp] verbinding gesloten"));
});

server.listen(POORT, () => {
  console.log(`[sessie] server actief op ${server instanceof https.Server ? "https" : "http"}://localhost:${POORT} (en WebSocket op hetzelfde adres)`);
  console.log(`[sessie] sessies worden bewaard in ${SESSIES_MAP}`);
});