/* ============================================================
   UR5 BRIDGE  —  koppelt de digital twin (browser) aan één of
   meerdere echte UR5-robots tegelijk
   ============================================================
   De browser kan zelf geen TCP-verbinding openen; dit script wel.
   Het leest de realtime-interface van elke robot (poort 30003) en
   geeft de gewrichtshoeken via WebSocket door aan de twin.
   URScript-commando's uit de twin worden doorgestuurd naar
   poort 30002 (secondary interface). De digitale I/O (standaard én
   de configureerbare "extension"-aansluiting) wordt via RTDE
   (poort 30004) uitgelezen en via dezelfde URScript-weg beschreven.

   INSTALLATIE (eenmalig, op de pc die aan de robot(s) hangt):
     1. Installeer Node.js (nodejs.org, LTS-versie).
     2. Open een terminal in deze map en voer uit:
          npm install ws modbus-serial
     3. Zie hieronder hoe je de robot-IP's meegeeft (teach pendant:
        Instellingen → Systeem → Netwerk, voor het IP-adres).

   MEERDERE ROBOTS TEGELIJK
     Deze bridge kan net zo goed één als meerdere robots aansturen.
     Elke robot krijgt zijn EIGEN WebSocket-poort, in dezelfde
     volgorde als de IP's: de eerste robot op 9090, de tweede op
     9091, de derde op 9092, enzovoort. Een digital twin of AR-
     viewer verbindt daardoor precies zoals altijd — je kiest alleen
     welke poort (dus welke robot) je in dat scherm invult.

     Twee manieren om de IP's mee te geven:

     A) Met parameters — de IP's staan meteen vast:
          node ur5-bridge.js 192.168.1.100 192.168.1.101
        (start hier twee robots: 192.168.1.100 op ws://localhost:9090,
         192.168.1.101 op ws://localhost:9091)

     B) Zonder parameters — de bridge vraagt ze één voor één op:
          node ur5-bridge.js
        Typ steeds één IP-adres in en druk op Enter; een lege regel
        (gewoon Enter, zonder IP) sluit de lijst af en start de
        bridge met de robots die je tot dan toe hebt ingevoerd.

   STARTEN (met één robot, zoals voorheen):
          node ur5-bridge.js
          (of direct: node ur5-bridge.js 192.168.1.100)
     Open daarna ur5-digital-twin.html en klik "Verbinden"
     (adres: ws://localhost:9090, of ws://<ip-van-deze-pc>:9090
     als de twin op een andere computer draait).

   NETWERK (directe ethernetkabel):
     Geef de robot en de pc een vast IP in hetzelfde subnet,
     robot 192.168.1.100 / pc bijv. 192.168.1.20, masker 255.255.255.0.
     Meerdere robots op één pc? Dan heeft elke robot zijn eigen vaste
     IP nodig (bijv. .100, .101, .102, …) in hetzelfde subnet.

   OP AFSTAND BEREIKBAAR MAKEN (wss:// direct vanuit dit script):
     Zet een certificaat en sleutel naast dit bestand als cert.pem
     en key.pem (of geef andere paden mee via de omgevingsvariabelen
     TLS_CERT en TLS_KEY). Staan die er, dan start de bridge zelf al
     beveiligd op wss:// (voor elke robot-poort); ontbreken ze, dan
     draait hij gewoon zoals altijd op onbeveiligd ws:// (prima voor
     lokaal testen).

   GRIJPER VIA UR-CONTROLLER (robot zonder Eye Box)
     In de twin kies je per robot hoe de grijper wordt aangestuurd. "UR-controller
     (URCap)" laadt en speelt via het dashboard twee programma's af die op de pendant
     staan (standaard grijper_open.urp en grijper_dicht.urp, met de OnRobot Grip-node).
     "Eye Box" gebruikt de Modbus-route hieronder.

   GRIJPER PER ROBOT (optioneel)
     Standaard gebruikt elke robot dezelfde grijper-instellingen
     (GRIJPER_IP, GRIJPER_POORT, GRIJPER_OPEN_MM). Heeft robot 2 een
     grijper op een ander Modbus-adres dan robot 1? Geef dat mee met
     een volgnummer erachter — 1 voor de eerste robot in de lijst, 2
     voor de tweede, enzovoort:
          GRIJPER_IP_1=192.168.1.1 GRIJPER_IP_2=192.168.2.1 node ur5-bridge.js 192.168.1.100 192.168.2.100
     Zonder zo'n genummerde variabele valt een robot terug op de
     gedeelde GRIJPER_IP (en die weer op 192.168.1.1).

   WS-POORTEN AANPASSEN (optioneel)
     Standaard begint de eerste robot op poort 9090. Een andere
     startpoort? Zet WS_POORT_BASIS:
          WS_POORT_BASIS=9200 node ur5-bridge.js 192.168.1.100 192.168.1.101
   ============================================================ */

const net = require("net");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const readline = require("readline");
const os = require("os");
const { exec } = require("child_process");
const WebSocket = require("ws");
const ModbusRTU = require("modbus-serial");

/* ------------------ Instellingen die voor elke robot gelden ------------------ */
const RT_POORT   = 30003;            // realtime interface (uitlezen, 125 Hz)
const CMD_POORT  = 30002;            // secondary interface (URScript sturen)
const RTDE_POORT = 30004;            // RTDE interface (digitale I/O uitlezen)
const DASH_POORT = 29999;            // dashboard-server (robotbeheer)
const ZEND_HZ    = 15;               // hoe vaak joints/IO naar de twin gaan
const RTDE_HZ    = 10;               // update-frequentie die we bij RTDE-protocolversie 2 opgeven
const WS_POORT_BASIS = +(process.env.WS_POORT_BASIS || 9090);   // eerste robot; elke volgende robot krijgt +1
const TLS_CERT   = process.env.TLS_CERT || "cert.pem";
const TLS_KEY    = process.env.TLS_KEY  || "key.pem";
const GRIJPER_MECHANISCH_MAX = 1100;   // RG2 = 1100 (110,0 mm); voor een RG6 is dit 1600 — puur de fysieke grens
const GRIJPER_MAX_KRACHT     = 400;    // RG2 = 400 (40,0 N); voor een RG6 wordt dit 1200
const GRIJPER_UNIT = 65;
/* Alleen deze beheercommando's zijn toegestaan (whitelist) */
const DASH_TOEGESTAAN = new Set([
  "power on", "power off", "brake release", "robotmode",
  "unlock protective stop", "safetystatus", "stop", "close popup"
]);
/* Freedrive via URScript. Start: programma dat freedrive aanzet en blijft
   draaien. Stop: leeg programma versturen — dat vervangt het draaiende
   programma, waarmee freedrive automatisch eindigt.                    */
const FREEDRIVE_AAN =
  "def fdrive():\n  freedrive_mode()\n  while (True):\n    sync()\n  end\nend";
const FREEDRIVE_UIT =
  "def fstop():\n  end_freedrive_mode()\nend";

/* Omgevingsvariabele per robot, met terugval: eerst "<NAAM>_<robotnr>"
   (1-based, dezelfde nummering als de "R1"/"R2"-labels in de log), dan de
   gedeelde "<NAAM>" (zoals voorheen, voor wie maar één robot gebruikt),
   dan de standaardwaarde.                                               */
function omgevingPerRobot(naam, robotNr, standaard) {
  const perRobot = process.env[`${naam}_${robotNr}`];
  if (perRobot !== undefined) return perRobot;
  const gedeeld = process.env[naam];
  if (gedeeld !== undefined) return gedeeld;
  return standaard;
}

/* ============================================================
   Eén robot + zijn eigen WebSocket-server — alles hierbinnen is
   losstaand per robot (eigen sockets, eigen programma-status, eigen
   grijperverbinding), zodat meerdere robots elkaar niet kunnen
   beïnvloeden ook al draaien ze in hetzelfde Node-proces.
   ============================================================ */
/* Alle fysieke robots die dit Node-proces bedient. De sessie-bridge gebruikt dit lijstje voor de koppelingen
   (welke virtuele robot hoort bij welke echte robotarm): nummer, naam, IP en de poort van zijn bridge. */
/* Opties in de terminal:  node ur5-bridge.js 192.168.0.11 192.168.0.12 --naam="RoboLab les 3" --schoon
     --naam=…   de naam van deze server in de lijst van de clients
     --schoon   begin helemaal leeg: de opgeslagen koppelingen worden niet geladen (en gewist)
   Wat geen optie is (geen --), is een robot-IP.                                                                   */
const OPTIES = {}, POS_ARGS = [];
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) OPTIES[m[1]] = m[2] === undefined ? true : m[2]; else if (a.trim()) POS_ARGS.push(a.trim());
}
const FYSIEK = new Map();   // robotNr -> { nr, label, poort, ip() }
/* Sessies van dit proces, zodat elke bridge-poort de lijst "servers in de buurt" kan geven: GET /ar-sessies (ook over https).
   Een client hoeft dan alleen het IP-adres van de laptop te weten; de sessie-server is niet meer nodig.                    */
const SESSIE_AFMELD = [];        // per bridge: meldt hem af bij de sessie-server en waarschuwt de clients
const SESSIE_INFO = new Map();   // poort -> (host) => { id, naam, host, wsUrl, robot, deelnemers }
const CORS_KOPPEN = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Private-Network": "true" };
function httpAfhandelaar(req, res) {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS_KOPPEN); res.end(); return; }
  if (req.method === "GET" && /^\/ar-sessies\/?(\?.*)?$/.test(req.url || "")) {
    const host = String(req.headers.host || "localhost").replace(/:\d+$/, "");     // het adres waarmee de client ons bereikt: dat werkt dus ook voor hem
    /* één sessie per proces (= per server): de eerste robot-poort is de ingang; de andere robots volgen via de koppelingen */
    const alle = [...SESSIE_INFO.entries()].sort((a, b) => a[0] - b[0]).map(([, f]) => f(host));
    const lijst = alle.slice(0, 1).map(x => ({ ...x, robot: alle.map(y => y.robot).join(", ") }));
    res.writeHead(200, { "Content-Type": "application/json", ...CORS_KOPPEN }); res.end(JSON.stringify(lijst)); return;
  }
  res.writeHead(200, { "Content-Type": "text/plain", ...CORS_KOPPEN }); res.end("UR5 bridge — GET /ar-sessies geeft de sessies\n");
}

function startRobotBridge(startIP, robotNr, wsPoort) {
  const label = `R${robotNr}`;
  const log = (cat, msg) => console.log(`[${label}/${cat}] ${msg}`);

  let robotIp = startIP;   // kan tijdens gebruik wisselen via "Wissel robot" in de twin
  FYSIEK.set(robotNr, { nr: robotNr, label, poort: wsPoort, ip: () => robotIp });

  /* -------- WebSocket-server voor deze ene robot -------- */
  let wss;
  const heeftCertificaat = fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY);
  if (heeftCertificaat) {
    const httpsServer = https.createServer({
      cert: fs.readFileSync(TLS_CERT),
      key:  fs.readFileSync(TLS_KEY),
    }, httpAfhandelaar);
    wss = new WebSocket.Server({ server: httpsServer });
    httpsServer.listen(wsPoort, () => {
      log("bridge", `beveiligde WebSocket-server actief op wss://<dit-adres>:${wsPoort}`);
    });
    httpsServer.on("error", err => log("bridge", `kon niet starten op poort ${wsPoort}: ${err.message}`));
  } else {
    const httpServer = http.createServer(httpAfhandelaar);
    wss = new WebSocket.Server({ server: httpServer });
    httpServer.listen(wsPoort);
    httpServer.on("error", err => log("bridge", `kon niet starten op poort ${wsPoort}: ${err.message}`));
    log("bridge", `WebSocket-server actief op ws://localhost:${wsPoort}`);
    log("bridge", `(onbeveiligd — leg ${TLS_CERT} en ${TLS_KEY} naast dit bestand voor wss://, geldt dan voor alle robots)`);
  }
  log("bridge", `robot-IP: ${robotIp}  (wisselen kan ook tijdens gebruik, via de twin)`);

  function broadcast(obj) {
    const data = JSON.stringify(obj);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
  }

  /* ------------------ Uitlezen: poort 30003 ------------------
     Elk pakket: int32 lengte (big-endian) gevolgd door doubles.
     q_actual (werkelijke gewrichtshoeken, rad ×6) staat op
     byte-offset 252: lengte(4) + tijd(8) + q_target/qd_target/
     qdd_target/I_target/M_target (5 × 6 × 8 bytes).             */
  let rtSocket = null;
  let buffer = Buffer.alloc(0);
  let laatsteQ = null;
  let laatsteQd = null;          // werkelijke gewrichtssnelheden (rad/s)
  let laatstePakketTijd = 0;

  function verbindRealtime() {
    rtSocket = net.createConnection(RT_POORT, robotIp, () => {
      log("robot", `verbonden met ${robotIp}:${RT_POORT}`);
      broadcast({ type: "status", robot: "verbonden" });
    });

    rtSocket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const len = buffer.readInt32BE(0);
        if (len < 4 || len > 4096) { buffer = Buffer.alloc(0); break; } // uit sync
        if (buffer.length < len) break;                                  // pakket nog niet compleet
        const pakket = buffer.slice(0, len);
        buffer = buffer.slice(len);
        if (len >= 252 + 48) {
          const q = [];
          for (let i = 0; i < 6; i++) q.push(pakket.readDoubleBE(252 + i * 8));
          laatsteQ = q;
          laatstePakketTijd = Date.now();
          if (len >= 300 + 48) {
            const qd = [];
            for (let i = 0; i < 6; i++) qd.push(pakket.readDoubleBE(300 + i * 8));
            laatsteQd = qd;
          }
        }
      }
    });

    rtSocket.on("error", err => log("robot", `fout: ${err.message}`));
    rtSocket.on("close", () => {
      log("robot", "verbinding verbroken — opnieuw proberen over 3 s");
      broadcast({ type: "status", robot: "verbroken" });
      laatsteQ = null;
      setTimeout(verbindRealtime, 3000);
    });
  }
  verbindRealtime();

  /* Wachten op ECHTE beweging. Het dashboard-antwoord "running" zegt weinig over een
     script dat via poort 30002 binnenkomt: dat kon "klaar" lijken terwijl de arm nog
     reed of nog moest beginnen, waardoor de grijper (of het volgende script) er dwars
     doorheen ging. Daarom kijken we naar de gewrichtssnelheden van de robot zelf.   */
  const snelheid = qd => Math.max(...qd.map(Math.abs));
  const afstand = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));
  const rtBeschikbaar = () => laatsteQ && laatsteQd && Date.now() - laatstePakketTijd < 500;
  async function wachtTotBeweging(qVoor, timeoutMs = 2500) {
    if (!rtBeschikbaar() || !qVoor) return false;
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      if (programmaAfbreken) throw new Error("afgebroken door gebruiker");
      if (afstand(laatsteQ, qVoor) > 0.003 || snelheid(laatsteQd) > 0.02) return true;
      await new Promise(r => setTimeout(r, 20));
    }
    return false;       // de arm bewoog niet (doel = huidige stand)
  }
  async function wachtTotStil(timeoutMs = 90000, stilMs = 400) {
    if (!rtBeschikbaar()) { await new Promise(r => setTimeout(r, 500)); return; }
    const t0 = Date.now();
    let stilSinds = null;
    while (Date.now() - t0 < timeoutMs) {
      if (programmaAfbreken) throw new Error("afgebroken door gebruiker");
      if (!rtBeschikbaar()) { await new Promise(r => setTimeout(r, 100)); continue; }
      if (snelheid(laatsteQd) < 0.004) {
        if (stilSinds === null) stilSinds = Date.now();
        if (Date.now() - stilSinds >= stilMs) return;
      } else stilSinds = null;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error("time-out: de arm kwam niet tot stilstand");
  }

  /* Joints met vaste frequentie naar de twin sturen */
  setInterval(() => {
    if (laatsteQ) broadcast({ type: "joints", q: laatsteQ });
  }, 1000 / ZEND_HZ);

  /* ------------------ Sturen: poort 30002 ------------------ */
  let laatsteScript = 0;
  function stuurURScript(script, stil) {
    laatsteScript = Date.now();
    const cmd = net.createConnection(CMD_POORT, robotIp, () => {
      cmd.write(script + "\n");
      cmd.end();
      if (!stil) log("robot", `URScript verstuurd: ${script.split("\n")[0]} ...`);
    });
    cmd.on("error", err => {
      log("robot", `versturen mislukt: ${err.message}`);
      broadcast({ type: "error", message: "URScript versturen mislukt: " + err.message });
    });
  }

  /* ------------------ Grijper: Modbus TCP naar de OnRobot Compute/Eye Box ------------------
     Rechtstreekse aansturing, buiten de robot en pendant om — geen .urp-
     bestanden, geen popups, geen laad/afspeel-vertraging. Geeft ook de
     ECHTE grijperstatus terug in plaats van een gok in de twin.
     Registerkaart (Modbus TCP, poort 502, unit-id 65), bevestigd werkend
     op de RG2:
       schrijven  0 = doelkracht (1/10 N)         1 = doelbreedte (1/10 mm)
                  2 = commando (1=grip, 8=stop, 16=grip met fingertip-offset)
       lezen    267 = werkelijke breedte (1/10 mm)
                268 = status: bit0 bezig, bit1 grip gedetecteerd,
                      bit2/3 S1 ingedrukt/getriggerd, bit4/5 S2 idem,
                      bit6 veiligheidsfout                                */
  const GRIJPER_IP = omgevingPerRobot("GRIJPER_IP", robotNr, "192.168.1.1");
  const GRIJPER_POORT = +omgevingPerRobot("GRIJPER_POORT", robotNr, 502);
  const grijperOpenMM = omgevingPerRobot("GRIJPER_OPEN_MM", robotNr, null);
  const GRIJPER_OPEN_BREEDTE = grijperOpenMM ? +grijperOpenMM * 10 : 1050;
  /* Standaard net iets onder het mechanische maximum (105,0 i.p.v. 110,0 mm) —
     helemaal tot de fysieke aanslag sturen geeft soms een klein "terugveer"-
     correctiebewegingetje van de motor zelf. Andere waarde nodig? Start de
     bridge met bijv. GRIJPER_OPEN_MM=100 (of GRIJPER_OPEN_MM_2=100 voor
     specifiek de tweede robot) node ur5-bridge.js                       */
  const modbusClient = new ModbusRTU();
  let grijperVerbonden = false;

  /* De Compute/Eye Box sluit een stille Modbus-verbinding soms zonder het te melden.
     Daarom: bij elke fout de verbinding sluiten en één keer opnieuw opbouwen,
     zodat de grijper niet meer "los- en vastgekoppeld" hoeft te worden.        */
  async function sluitGrijperVerbinding() {
    grijperVerbonden = false;
    try { await new Promise(r => modbusClient.close(r)); } catch (e) { /* al dicht */ }
  }
  async function metGrijperHerstel(fn) {
    try { return await fn(); }
    catch (err) {
      if (/veiligheidsschakelaar|afgebroken/i.test(err.message)) throw err;
      log("grijper", `Modbus-fout (${err.message}) — verbinding opnieuw opbouwen`);
      await sluitGrijperVerbinding();
      await new Promise(r => setTimeout(r, 400));
      return await fn();
    }
  }
  async function zorgVoorGrijperVerbinding() {
    if (grijperVerbonden) return;
    await modbusClient.connectTCP(GRIJPER_IP, { port: GRIJPER_POORT });
    modbusClient.setID(GRIJPER_UNIT);
    modbusClient.setTimeout(2000);
    grijperVerbonden = true;
    log("grijper", `Modbus-verbinding actief met ${GRIJPER_IP}:${GRIJPER_POORT}`);
  }

  async function leesGrijperStatus() { return metGrijperHerstel(leesGrijperStatusRuw); }
  async function leesGrijperStatusRuw() {
    await zorgVoorGrijperVerbinding();
    const statusRes = await modbusClient.readHoldingRegisters(268, 1);
    const breedteRes = await modbusClient.readHoldingRegisters(267, 1);
    const status = statusRes.data[0];
    return {
      bezig: !!(status & 0b0000001),
      gripGedetecteerd: !!(status & 0b0000010),
      s1Getriggerd: !!(status & 0b0001000),      // bit3: tijdens beweging tegen iets aangelopen
      s2Getriggerd: !!(status & 0b0100000),      // bit5: idem, andere schakelaar
      foutBijInschakelen: !!(status & 0b1000000), // bit6: stond al ingedrukt bij het aanzetten van de grijper
      veiligheidsfout: !!(status & 0b1101000),
      breedteMM: breedteRes.data[0] / 10,
    };
  }

  async function stuurGrijperCommando(open, krachtN) { return metGrijperHerstel(() => stuurGrijperCommandoRuw(open, krachtN)); }
  async function grijperReset() {
    await sluitGrijperVerbinding();
    await new Promise(r => setTimeout(r, 300));
    await zorgVoorGrijperVerbinding();
    await modbusClient.writeRegisters(0, [0, 0, 8]);        // 8 = stop
    await new Promise(r => setTimeout(r, 300));
    return await leesGrijperStatusRuw();
  }
  async function stuurGrijperCommandoRuw(open, krachtN) {
    await zorgVoorGrijperVerbinding();
    const kracht10 = Number.isFinite(krachtN)
      ? Math.max(0, Math.min(GRIJPER_MAX_KRACHT, Math.round(krachtN * 10)))
      : GRIJPER_MAX_KRACHT;
    const breedte10 = open ? GRIJPER_OPEN_BREEDTE : 0;
    await modbusClient.writeRegisters(0, [kracht10, breedte10, 16]);   // 16 = grip met fingertip-offset
  }

  async function wachtTotGrijperKlaar(timeoutMs = 10000) {
    const start = Date.now();
    /* Eerst wachten tot de grijper ECHT begint ("bezig" gaat aan, max 1 s). Een te
       vroege status "niet bezig" liet het programma doorlopen terwijl de grijper
       nog moest beginnen — daardoor liep de grijpactie mee in de volgende beweging. */
    let begonnen = false;
    const t0 = Date.now();
    while (Date.now() - t0 < 1000) {
      if (programmaAfbreken) throw new Error("afgebroken door gebruiker");
      const st = await leesGrijperStatus();
      if (st.bezig) { begonnen = true; break; }
      await new Promise(r => setTimeout(r, 50));
    }
    while (Date.now() - start < timeoutMs) {
      if (programmaAfbreken) throw new Error("afgebroken door gebruiker");
      const status = await leesGrijperStatus();
      if (status.s1Getriggerd || status.s2Getriggerd) {
        const reden = status.s1Getriggerd && status.s2Getriggerd ? "beide veiligheidsschakelaars (S1 én S2)"
          : status.s1Getriggerd ? "veiligheidsschakelaar S1" : "veiligheidsschakelaar S2";
        throw new Error("grijper: " + reden + " geactiveerd tijdens een beweging — gebruik 'Grijper resetten' in de twin");
      }
      if (status.foutBijInschakelen && !grijperFoutBitGemeld) {
        grijperFoutBitGemeld = true;
        log("grijper", "let op: statusbit 'schakelaar ingedrukt bij inschakelen' staat aan — wordt genegeerd");
      }
      if (!status.bezig) { await new Promise(r => setTimeout(r, 250)); return status; }   // korte uitrusttijd na de beweging
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("time-out: grijper bleef bezig");
  }
  let grijperFoutBitGemeld = false;

  /* ------------------ Dashboard: poort 29999 ------------------
     Tekstcommando's voor robotbeheer: "power on", "brake release",
     "power off", "robotmode", "unlock protective stop", enz.
     Vereist op de e-Series: Remote Control ingeschakeld én de
     robot in Remote-stand (rechtsboven op de pendant).          */
  let dashSocket = null;
  let dashBuffer = "";
  let dashWachters = [];               // FIFO: opeenvolgende dashboard-antwoorden horen bij opeenvolgende vragen

  function verbindDashboard() {
    dashSocket = net.createConnection(DASH_POORT, robotIp, () => {
      log("dashboard", `verbonden met ${robotIp}:${DASH_POORT}`);
    });
    dashSocket.on("data", chunk => {
      dashBuffer += chunk.toString();
      let i;
      while ((i = dashBuffer.indexOf("\n")) >= 0) {
        const regel = dashBuffer.slice(0, i).trim();
        dashBuffer = dashBuffer.slice(i + 1);
        if (regel) {
          const w = dashWachters.length ? dashWachters.shift() : null;
          if (!(w && w.stil)) { log("dashboard", regel); broadcast({ type: "dashboard", antwoord: regel }); }
          if (w) w(regel);   // koppel aan oudste openstaande vraag
        }
      }
    });
    dashSocket.on("error", err => log("dashboard", `fout: ${err.message}`));
    dashSocket.on("close", () => {
      log("dashboard", "verbinding verbroken — opnieuw proberen over 3 s");
      dashSocket = null;
      dashWachters.forEach(w => w("__VERBROKEN__"));
      dashWachters = [];
      setTimeout(verbindDashboard, 3000);
    });
  }
  verbindDashboard();

  function stuurDashboard(cmd) {
    if (dashSocket && !dashSocket.destroyed) {
      dashSocket.write(cmd + "\n");
      log("dashboard", `> ${cmd}`);
    } else {
      broadcast({ type: "error", message: "Dashboard niet verbonden." });
    }
  }

  /* Stuurt een dashboardcommando en wacht op precies dat ene antwoord.
     Werkt omdat de dashboard-server op één verbinding altijd in
     volgorde antwoordt — zolang wij ook in volgorde vragen.       */
  function dashboardVraag(cmd, timeoutMs = 6000, stil = false) {
    return new Promise((resolve, reject) => {
      if (!dashSocket || dashSocket.destroyed) { reject(new Error("dashboard niet verbonden")); return; }
      const timer = setTimeout(() => reject(new Error("time-out op: " + cmd)), timeoutMs);
      const wacht = regel => {
        clearTimeout(timer);
        if (regel === "__VERBROKEN__") reject(new Error("dashboardverbinding verbroken tijdens: " + cmd));
        else resolve(regel);
      };
      wacht.stil = stil;
      dashWachters.push(wacht);
      dashSocket.write(cmd + "\n");
      if (!stil) log("dashboard", `> ${cmd}`);
    });
  }


  /* Pendantprogramma automatisch laden en starten (dashboard, remote control aan).
     Wordt gebruikt bij "Lezen en sturen via een pendantprogramma": het programma schrijft de stand
     naar de registers en voert opdrachten uit. De bridge houdt het draaiend; een los URScript
     (bijv. een armbeweging) stopt het, daarna start de bridge het weer. */
  let slProg = null;
  function stopProgramma() { if (slProg) { slProg.dood = true; clearInterval(slProg.timer); slProg = null; } }
  function startProgramma(naam) {
    stopProgramma();
    naam = String(naam || "").trim();
    if (!naam) return;
    if (!/^[\w .\-()]+$/.test(naam)) { log("slede", `ongeldige programmanaam: ${naam}`); return; }
    const bestand = /\.urp$/i.test(naam) ? naam : naam + ".urp";
    const kort = bestand.replace(/\.urp$/i, "").toLowerCase();
    const P = slProg = { dood: false, timer: null, bezig: false, laatst: "" };
    const meld = t => { if (t !== P.laatst) { P.laatst = t; log("slede", t); } };
    const cyclus = async () => {
      if (P.dood || P.bezig) return;
      P.bezig = true;
      try {
        const mode = await dashboardVraag("robotmode", 6000, true);
        if (!/RUNNING/i.test(mode)) { meld(`programma niet gestart: robot staat niet op RUNNING (${mode})`); return; }
        const st = await dashboardVraag("programState", 6000, true);
        if (/^PLAYING/i.test(st) && st.toLowerCase().includes(kort)) { meld(`programma ${bestand} draait`); return; }
        if (Date.now() - laatsteScript < 4000) return;               // net een URScript verstuurd: even wachten
        if (!st.toLowerCase().includes(kort)) {
          const l = await dashboardVraag("load " + bestand);
          if (!/^Loading program/i.test(l)) { meld(`programma laden mislukt: ${l} — staat ${bestand} op de pendant opgeslagen?`); return; }
          meld(`programma ${bestand} geladen`);
        }
        const r = await dashboardVraag("play");
        meld(/^Starting program/i.test(r) ? `programma ${bestand} gestart` : `programma starten mislukt: ${r} — staat de robot in remote control?`);
      } catch (e) { meld(`programma starten: ${e.message}`); }
      finally { P.bezig = false; }
    };
    P.timer = setInterval(cyclus, 4000);
    cyclus();
  }

  /* ------------------ Digitale I/O: RTDE (poort 30004) lezen ------------------
     De echte "extension bus" van de UR-controller (de configureerbare I/O,
     los van de 2 vaste standaard-in/uitgangen) is via geen van de andere
     drie poorten rechtstreeks en betrouwbaar uit te lezen: de vaste byte-
     offsets van poort 30003 verschillen per firmwareversie. RTDE (30004) is
     de door UR zelf bedoelde weg hiervoor: je vraagt met NAMEN de velden op
     die je wilt (hier "actual_digital_input_bits" en "..._output_bits"),
     in plaats van te gokken op een byte-positie.

     Protocol (binair):
       header = 2 bytes grootte (big-endian) + 1 byte berichttype
       'V' (86) = protocolversie aanvragen/bevestigen
       'O' (79) = output-recept opzetten (welke velden willen we?)
       'S' (83) = datastroom starten
       'U' (85) = databericht: 1 byte recept-id + de velden, in de
                  aangevraagde volgorde, elk als UINT64 (8 bytes)
       'M' (77) = tekstmelding van de controller (fout/waarschuwing)

     Bitindeling van beide UINT64-velden (vaste UR-indeling):
       bit 0-7   = standaard digitale I/O   (DI0-7 / DO0-7)
       bit 8-15  = configureerbare I/O, ofwel de "extension"-aansluiting
                   op de controllerkast (CI0-7 / CO0-7)
       bit 16-17 = tool-I/O (niet gebruikt in deze bridge)

     Protocolversie-onderhandeling: nieuwere controllers (e-Series/
     PolyScope 5.x) verwachten protocolversie 2 — het opzetbericht ('O')
     krijgt dan een extra 8-byte frequentieveld VOOR de veldnamen, en het
     antwoord daarop begint met een extra recept-id-byte. Oudere
     controllers (CB3/PolyScope 3.x) kennen alleen versie 1, zonder dat
     frequentieveld. Vandaar: eerst versie 2 proberen, bij weigering
     terugvallen op versie 1.                                            */
  let rtdeSocket = null;
  let rtdeBuffer = Buffer.alloc(0);
  let laatsteIO = null;   // { standaardIn/Uit, extensieIn/Uit: elk een array van 8 booleans }
  let rtdeVersie = null;          // onderhandelde versie zodra de robot 'm heeft geaccepteerd
  let rtdeGevraagdeVersie = 2;    // welke versie we nu net hebben aangevraagd

  function rtdeBericht(type, payload = Buffer.alloc(0)) {
    const buf = Buffer.alloc(3 + payload.length);
    buf.writeUInt16BE(3 + payload.length, 0);
    buf.writeUInt8(type, 2);
    payload.copy(buf, 3);
    return buf;
  }

  function bitsNaarArray(bigintWaarde, startBit, aantal) {
    const r = [];
    for (let i = 0; i < aantal; i++) r.push(!!((bigintWaarde >> BigInt(startBit + i)) & 1n));
    return r;
  }

  function vraagRTDEVersieAan(versie) {
    rtdeGevraagdeVersie = versie;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(versie, 0);
    rtdeSocket.write(rtdeBericht(86, payload));
  }

  function stuurRTDEOutputSetup() {
    const namen = "actual_digital_input_bits,actual_digital_output_bits";
    if (rtdeVersie === 2) {
      const freq = Buffer.alloc(8);
      freq.writeDoubleBE(RTDE_HZ, 0);
      rtdeSocket.write(rtdeBericht(79, Buffer.concat([freq, Buffer.from(namen, "ascii")])));
    } else {
      rtdeSocket.write(rtdeBericht(79, Buffer.from(namen, "ascii")));   // versie 1: geen frequentieveld
    }
  }

  function verwerkRTDEBericht(type, payload) {
    if (type === 86) {                                    // antwoord op protocolversie-verzoek: 1 byte, 1 = geaccepteerd
      const geaccepteerd = payload.length >= 1 && payload.readUInt8(0) === 1;
      if (geaccepteerd) {
        rtdeVersie = rtdeGevraagdeVersie;
        log("io", `RTDE-protocolversie ${rtdeVersie} geaccepteerd door de robot`);
        stuurRTDEOutputSetup();
      } else if (rtdeGevraagdeVersie === 2) {
        log("io", "RTDE-protocolversie 2 geweigerd — dit is waarschijnlijk een oudere controller (CB3), probeer versie 1");
        vraagRTDEVersieAan(1);
      } else {
        log("io", "RTDE-protocolversie 1 óók geweigerd — digitale I/O uitlezen lukt niet op deze robot/firmware");
      }
    } else if (type === 79) {                               // antwoord op recept-opzet: teruggegeven types
      /* Bij protocolversie 2 begint het antwoord met een extra recept-id-byte
         vóór de (ASCII) typenamen; bij versie 1 is het antwoord alleen de
         typenamen. Sla de verkeerde bytes over en je leest "UINT64,UINT64"
         als iets anders (of denkt ten onrechte dat het veld niet bestaat).   */
      const types = rtdeVersie === 2
        ? (payload.length > 1 ? payload.slice(1).toString("ascii") : "")
        : payload.toString("ascii");
      if (!types || /NOT_FOUND/i.test(types)) {
        log("io", `RTDE meldt een onbekend veld (${types || "leeg antwoord"}) — digitale I/O uitlezen lukt niet op deze robot/firmware`);
      }
      rtdeSocket.write(rtdeBericht(83));                    // 'S' datastroom starten
    } else if (type === 83) {
      log("io", "RTDE-datastroom voor digitale I/O gestart");
    } else if (type === 85) {                               // databericht
      if (payload.length < 1 + 8 + 8) return;               // 1 byte recept-id + 2×8 bytes velden
      const inBits = payload.readBigUInt64BE(1);
      const uitBits = payload.readBigUInt64BE(9);
      laatsteIO = {
        standaardIn:  bitsNaarArray(inBits, 0, 8),
        extensieIn:   bitsNaarArray(inBits, 8, 8),
        standaardUit: bitsNaarArray(uitBits, 0, 8),
        extensieUit:  bitsNaarArray(uitBits, 8, 8),
      };
    } else if (type === 77) {
      log("io", `RTDE-melding: ${payload.toString("ascii")}`);
    }
  }

  function verbindRTDE() {
    rtdeSocket = net.createConnection(RTDE_POORT, robotIp, () => {
      log("io", `RTDE verbonden met ${robotIp}:${RTDE_POORT}`);
      rtdeVersie = null;
      vraagRTDEVersieAan(2);                                // eerst de moderne versie proberen, met terugval op 1
    });

    rtdeBuffer = Buffer.alloc(0);
    rtdeSocket.on("data", chunk => {
      rtdeBuffer = Buffer.concat([rtdeBuffer, chunk]);
      while (rtdeBuffer.length >= 3) {
        const size = rtdeBuffer.readUInt16BE(0);
        if (size < 3 || size > 4096) { rtdeBuffer = Buffer.alloc(0); break; }   // uit sync
        if (rtdeBuffer.length < size) break;                                    // bericht nog niet compleet
        const type = rtdeBuffer.readUInt8(2);
        const payload = rtdeBuffer.slice(3, size);
        rtdeBuffer = rtdeBuffer.slice(size);
        verwerkRTDEBericht(type, payload);
      }
    });

    rtdeSocket.on("error", err => log("io", `RTDE-fout: ${err.message}`));
    rtdeSocket.on("close", () => {
      log("io", "RTDE-verbinding verbroken — opnieuw proberen over 3 s");
      laatsteIO = null;
      rtdeVersie = null;
      setTimeout(verbindRTDE, 3000);
    });
  }
  verbindRTDE();

  /* ------------------ Stand van de slede (7e as) lezen ------------------
     De URCap van de slede geeft de stand alleen via een URScript-functie
     (get_slidekit_position(), in mm). Die kun je niet rechtstreeks uitlezen.
     Daarom stuurt de bridge elke ~0,4 s een klein script naar poort 30002 dat de
     stand in een uitvoer-register van de controller zet (write_output_float_register).
     Een eigen RTDE-verbinding (poort 30004) leest dat register mee en de twin
     krijgt de waarde als { type: "asPositie", mm }.                                */

  /* ------------------ Slede via registers (programma op de pendant) ------------------
     Werkt ook als "remote control" uit staat: de controller weigert dan losse scripts op poort 30002,
     maar RTDE-registers werken wel. Op de pendant draait een vast programma dat de daemon van de slidekit aanroept.
       uit  (pendant -> bridge):  register B   = stand van de as (mm)       register B+1 = bevestiging (id van de laatste opdracht)
       in   (bridge -> pendant):  register B   = doel (mm)   B+1 = opdracht-id   B+2 = snelheid   B+3 = versnelling   B+4 = vertraging   */
  let slReg = null;
  function stopSlideRegisters() {
    if (!slReg) return;
    slReg.dood = true;
    clearInterval(slReg.timer);
    if (slReg.auto && slReg.scriptGestuurd) {          // het lopende slede-programma vervangen door een leeg programma dat meteen eindigt
      try {
        const c = net.createConnection(CMD_POORT, robotIp, () => { c.write("sec slidekit_bridge():\n  textmsg(\"slede-programma gestopt\")\nend\n"); c.end(); });
        c.on("error", () => {});
      } catch {}
    }
    try { slReg.sock && slReg.sock.destroy(); } catch {}
    slReg = null;
  }
  /* modus van de slede: "register" (programma draait op de pendant), "lezen" (de bridge stuurt een klein leesprogramma) of "bridge" (leest en voert opdrachten uit) */
  const slMod = msg => msg.modus === "lezen" || msg.modus === "bridge" || msg.modus === "register" ? msg.modus : (msg.auto ? "bridge" : "register");
  function startSlideRegisters(base, modus, poort) {
    stopSlideRegisters();
    base = Math.max(24, Math.min(43, Math.round(+base || 24)));
    poort = Math.round(+poort || 30405);
    const L = slReg = { dood: false, buf: Buffer.alloc(0), sock: null, base, modus, auto: modus !== "register", poort, waarden: [0, 0, 300, 0.5, 0.5], inId: 0, laatste: null, ack: null, hb: null, hbTijd: Date.now(), t0: Date.now(), nulGemeld: false, timer: null, herstarts: 0, opgegeven: false, scriptGestuurd: false, niveau: 0, stap: "", pakketten: 0 };
    /* niveau 0: 3 uitvoer- en 5 invoerregisters; 1: alleen 3 uitvoerregisters (lezen); 2: alleen register B (lezen).
       Resetten of sluiten van de controller vóór de eerste gegevens geeft een stap terug, zodat lezen in elk geval werkt. */
    const verbind = () => {
      if (L.dood) return;
      L.buf = Buffer.alloc(0); L.inId = 0; L.stap = "versie"; L.pakketten = 0;
      const sock = L.sock = net.createConnection(RTDE_POORT, robotIp, () => {
        const pl = Buffer.alloc(2); pl.writeUInt16BE(2, 0);
        sock.write(rtdeBericht(86, pl));
      });
      sock.on("data", chunk => {
        L.buf = Buffer.concat([L.buf, chunk]);
        while (L.buf.length >= 3) {
          const size = L.buf.readUInt16BE(0);
          if (size < 3 || size > 4096) { L.buf = Buffer.alloc(0); break; }
          if (L.buf.length < size) break;
          const type = L.buf.readUInt8(2), payload = L.buf.slice(3, size);
          L.buf = L.buf.slice(size);
          if (type === 86) {
            if (payload.length >= 1 && payload.readUInt8(0) === 1) {
              const freq = Buffer.alloc(8); freq.writeDoubleBE(10, 0);
              L.stap = "uitvoer";
              const aantal = L.niveau >= 2 ? 1 : 3;
              L.uitAantal = aantal;
              sock.write(rtdeBericht(79, Buffer.concat([freq, Buffer.from([0, 1, 2].slice(0, aantal).map(i => `output_double_register_${base + i}`).join(","), "ascii")])));
            } else { broadcast({ type: "error", message: "De controller ondersteunt RTDE versie 2 niet; de slede kan niet via registers worden aangestuurd." }); }
          } else if (type === 79) {
            const types = payload.length > 1 ? payload.slice(1).toString("ascii") : "";
            if (types.split(",").length !== L.uitAantal || !types.split(",").every(t => /^DOUBLE$/i.test(t))) { log("slede", `RTDE kent de uitvoerregisters niet (antwoord: ${types || "leeg"})`); broadcast({ type: "error", message: "RTDE kent de uitvoerregisters niet (antwoord: " + (types || "leeg") + ")." }); return; }
            if (L.niveau >= 1) { L.stap = "start"; sock.write(rtdeBericht(83)); return; }       // alleen lezen
            L.stap = "invoer";
            const namen = [0, 1, 2, 3, 4].map(i => `input_double_register_${base + i}`).join(",");
            sock.write(rtdeBericht(73, Buffer.from(namen, "ascii")));
          } else if (type === 73) {
            const types = payload.length > 1 ? payload.slice(1).toString("ascii") : "";
            if (!/DOUBLE/i.test(types) || /NOT_FOUND/i.test(types)) { broadcast({ type: "error", message: "RTDE kent de invoerregisters niet (antwoord: " + (types || "leeg") + ")." }); return; }
            L.inId = payload.readUInt8(0);
            L.stap = "start";
            sock.write(rtdeBericht(83));
          } else if (type === 83) {
            log("slede", `registers ${base}/${base + 1} worden gelezen, ${base}–${base + 4} gebruikt voor opdrachten`);
            L.stap = "data"; if (L.niveau) log("slede", `alleen lezen (terugvalniveau ${L.niveau}): sturen via registers kan zo niet`);
            L.pakketten = 0; setTimeout(() => { if (!L.dood && !L.pakketten) log("slede", "RTDE is gestart maar stuurt geen gegevens — controleer of de RTDE-registers vrij zijn (poort 30004)"); }, 3000);
            stuurWaarden();
            if (L.auto && !L.scriptGestuurd) { L.scriptGestuurd = true; stuurSlideScript(); }
          } else if (type === 85) {
            if (!L.pakketten++) log("slede", `eerste RTDE-gegevens ontvangen (${payload.length} bytes)`);
            if (payload.length >= 9) {
              const mm = payload.readDoubleBE(1), ack = payload.length >= 17 ? payload.readDoubleBE(9) : L.ack, hb = payload.length >= 25 ? payload.readDoubleBE(17) : L.hb;
              if (hb !== L.hb) { L.hb = hb; L.hbTijd = Date.now(); L.herstarts = 0; L.opgegeven = false; }
              if (isFinite(mm)) broadcast({ type: "asPositie", mm, register: base });
              if (mm !== L.laatste) { if (L.laatste === null || Math.abs(mm - L.laatste) >= 1) log("slede", `register ${base} = ${mm.toFixed(1)} mm`); L.laatste = mm; }
              if (L.ack !== ack && ack !== null && ack !== undefined) { L.ack = ack; broadcast({ type: "asKlaar", id: ack }); }
              if (mm === 0 && !L.nulGemeld && Date.now() - L.t0 > 8000) { L.nulGemeld = true; log("slede", `register ${base} blijft 0 — draait het slede-programma op de pendant (Play)?`); }
            }
          } else if (type === 77) {
            log("slede", `RTDE-melding: ${payload.toString("ascii")}`);
          }
        }
      });
      sock.on("error", err => log("slede", `RTDE-fout in stap "${L.stap}": ${err.message}`));
      sock.on("close", () => { if (!L.dood) {
        if (L.stap !== "data" || !L.pakketten) { if (L.niveau < 2) { L.niveau++; log("slede", `RTDE brak af in stap "${L.stap}" — ik probeer het eenvoudiger (niveau ${L.niveau})`); } }
        log("slede", "RTDE-verbinding voor de registers gesloten — opnieuw verbinden over 3 s"); setTimeout(verbind, 3000); } });
    };
    const stuurWaarden = () => {
      if (!L.sock || L.sock.destroyed || !L.inId) return;
      const b = Buffer.alloc(1 + 8 * 5); b.writeUInt8(L.inId, 0);
      L.waarden.forEach((w, i) => b.writeDoubleBE(+w || 0, 1 + 8 * i));
      L.sock.write(rtdeBericht(85, b));
    };
    /* Eén secundair programma doet alles: stand schrijven (B), opdrachten uit de registers uitvoeren, bevestigen (B+1) en een hartslag (B+2).
       De controller draait maar één secundair programma tegelijk; daarom mag dit het enige zijn dat de bridge naar poort 30002 stuurt.
       move_to_remote_position wacht niet: de lus blijft dus de stand schrijven terwijl de slede rijdt. */
    const leesScript = () => [
      "sec slidekit_lezen():",
      `  textmsg("slede-lezer: start")`,
      `  skf = rpc_factory("xmlrpc", "http://127.0.0.1:${L.poort}/RPC2")`,
      `  textmsg("slede-lezer: rpc_factory ok")`,
      "  hartslag = 0.0",
      "  while True:",
      `    write_output_float_register(${base}, skf.get_position() * 1.0)`,
      `    if hartslag < 1.0:`,
      `      textmsg("slede-lezer: eerste stand gelezen")`,
      `    end`,
      "    hartslag = hartslag + 1.0",
      `    write_output_float_register(${base + 2}, hartslag)`,
      "    sleep(0.2)",
      "  end",
      "end",
      ""].join("\n");
    const slideScript = () => L.modus === "lezen" ? leesScript() : volScript();
    const volScript = () => [
      "sec slidekit_bridge():",
      `  skf = rpc_factory("xmlrpc", "http://127.0.0.1:${L.poort}/RPC2")`,
      `  gezien = read_input_float_register(${base + 1})`,
      "  hartslag = 0.0",
      "  wacht_op = 0.0",
      "  doel = 0.0",
      "  teller = 0",
      "  while True:",
      `    pos = skf.get_position() * 1.0`,
      `    write_output_float_register(${base}, pos)`,
      "    hartslag = hartslag + 1.0",
      `    write_output_float_register(${base + 2}, hartslag)`,
      `    opdr = read_input_float_register(${base + 1})`,
      "    if opdr != gezien and opdr > 0:",
      "      gezien = opdr",
      "      skf.move_stop()",
      "      skf.error_Reset()",
      "      sleep(1.5)",
      `      skf.setup_vel(read_input_float_register(${base + 2}))`,
      `      skf.setup_acc(read_input_float_register(${base + 3}))`,
      `      skf.setup_dec(read_input_float_register(${base + 4}))`,
      `      doel = read_input_float_register(${base})`,
      "      skf.move_to_remote_position(doel)",
      "      wacht_op = opdr",
      "      teller = 0",
      "    end",
      "    if wacht_op > 0:",
      "      teller = teller + 1",
      "      verschil = pos - doel",
      "      if verschil < 0:",
      "        verschil = -verschil",
      "      end",
      "      if teller > 5 and skf.is_moving() == False and (verschil <= 2.0 or teller > 40):",
      `        write_output_float_register(${base + 1}, wacht_op)`,
      "        wacht_op = 0.0",
      "      end",
      "    end",
      "    sleep(0.1)",
      "  end",
      "end",
      ""].join("\n");
    const stuurSlideScript = () => {
      L.hbTijd = Date.now();
      const c = net.createConnection(CMD_POORT, robotIp, () => { c.write(slideScript()); log("slede", "slede-programma naar de controller gestuurd (secundair programma); ik luister 12 s naar meldingen van de controller"); });
      const gezien = new Set();
      c.setTimeout(12000, () => c.destroy());
      let verzonden = false; c.on("connect", () => { verzonden = true; });
      c.on("error", err => { if (verzonden && err.code === "ECONNRESET") return; log("slede", `slede-programma sturen mislukt: ${err.message}`); broadcast({ type: "error", message: "Slede-programma sturen mislukt: " + err.message }); });
      c.on("close", () => { if (gezien.size === 0) log("slede", "de controller heeft op poort 30002 geen enkele melding teruggestuurd"); });
      /* Alles wat de controller als tekst terugstuurt wordt getoond (ook de textmsg-regels van het script zelf) */
      c.on("data", chunk => {
        (chunk.toString("latin1").match(/[ -~]{8,}/g) || []).forEach(t => {
          t = t.trim();
          if (!t || gezien.has(t)) return;
          gezien.add(t); log("slede", `controller: ${t}`);
        });
      });
    };
    if (L.auto) {
      L.timer = setInterval(() => {
        if (L.dood || !L.inId) return;
        if (Date.now() - L.hbTijd > 5000) {
          if (L.herstarts >= 2) {                          // niet blijven proberen: elke poging kan op de pendant een foutmelding geven
            if (!L.opgegeven) { L.opgegeven = true; log("slede", "het slede-programma geeft geen hartslag na 3 pogingen — gestopt met sturen. Kijk op de pendant (Log en meldingen) en kies in de twin Via: Alleen simulatie om te stoppen."); broadcast({ type: "error", message: "Het slede-programma op de controller geeft geen levensteken. Kijk op de pendant naar meldingen en het logboek." }); }
            return;
          }
          L.herstarts++;
          log("slede", `geen hartslag van het slede-programma — opnieuw sturen (poging ${L.herstarts + 1}/3)`); stuurSlideScript();
        }
      }, 2000);
    }
    L.stuur = (doel, id, vel, acc, dec) => { L.waarden = [doel, id, vel, acc, dec]; stuurWaarden(); };
    verbind();
  }
  let slLees = null;
  function stopSlideLezer() {
    if (!slLees) return;
    clearInterval(slLees.timer);
    slLees.dood = true;
    try { slLees.sock && slLees.sock.destroy(); } catch {}
    try { slLees.stopCmd && slLees.stopCmd(); } catch {}
    slLees = null;
  }
  function startSlideLezer(reg, functie, ms, poort) {
    stopSlideLezer();
    reg = Math.max(0, Math.min(47, Math.round(+reg || 24)));
    poort = Math.round(+poort || 0);
    if (poort > 0 && poort < 65536) functie = "skf.get_position() * 1.0";      // via de XML-RPC-daemon van de slidekit-URCap
    else if (!/^[A-Za-z_][A-Za-z0-9_]*\(\s*\)$/.test(String(functie || ""))) { broadcast({ type: "error", message: "Ongeldige leesfunctie voor de slede: " + functie }); return; }
    const L = slLees = { dood: false, buf: Buffer.alloc(0), timer: null, sock: null, versie: 0, gezien: new Set(), laatste: null, t0: Date.now(), nulGemeld: false };
    /* "sec" = secondary-programma: loopt naast een draaiend programma en stopt een bewegende robot NIET.
       Een gewoon "def"-programma op poort 30002 vervangt het lopende programma. */
    const rpcRegel = poort > 0 && poort < 65536 ? `  skf = rpc_factory("xmlrpc", "http://127.0.0.1:${poort}/RPC2")\n` : "";
    /* Eén script met een eigen lus (5×/s), in plaats van elke seconde een nieuw script: dat werd na de eerste keer niet meer uitgevoerd.
       Het script wordt af en toe opnieuw gestuurd; een nieuw secundair programma vervangt het vorige. */
    const script = `sec slidekit_lees():\n${rpcRegel}  while True:\n    write_output_float_register(${reg}, ${functie})\n    sleep(0.2)\n  end\nend\n`;
    let cmdSock = null, cmdFoutGelogd = false;
    const cmdStuur = () => {
      if (L.dood) return;
      if (!cmdSock || cmdSock.destroyed) {
        cmdSock = net.createConnection(CMD_POORT, robotIp);       // één blijvende verbinding, geen nieuwe per keer
        cmdSock.setTimeout(5000, () => cmdSock.destroy());
        cmdSock.on("error", err => { if (!cmdFoutGelogd) { cmdFoutGelogd = true; log("slede", `leesverbinding naar ${robotIp}:${CMD_POORT} mislukt: ${err.message}`); } cmdSock.destroy(); });
        cmdSock.on("connect", () => { cmdFoutGelogd = false; cmdSock.setTimeout(0); });
        /* De controller meldt scriptfouten als tekst op deze verbinding. Toon alles wat op een fout van de slede lijkt. */
        cmdSock.on("data", chunk => {
          const tekst = chunk.toString("latin1");
          (tekst.match(/[ -~]{14,}/g) || []).forEach(t => {
            if (/exception|error|rpc|slidekit|xml|syntax|compile|not defined|undefined|fault|refused/i.test(t) && !L.gezien.has(t)) {
              L.gezien.add(t); if (L.gezien.size > 200) L.gezien.clear();
              log("slede", `melding van de controller: ${t.trim()}`);
            }
          });
        });
      }
      if (cmdSock.writable) cmdSock.write(script);
    };
    L.stopCmd = () => { try { cmdSock && cmdSock.destroy(); } catch {} };
    const verbind = () => {
      if (L.dood) return;
      L.buf = Buffer.alloc(0); L.versie = 0;
      const sock = L.sock = net.createConnection(RTDE_POORT, robotIp, () => {
        const pl = Buffer.alloc(2); pl.writeUInt16BE(2, 0);
        sock.write(rtdeBericht(86, pl));
      });
      sock.on("data", chunk => {
        L.buf = Buffer.concat([L.buf, chunk]);
        while (L.buf.length >= 3) {
          const size = L.buf.readUInt16BE(0);
          if (size < 3 || size > 4096) { L.buf = Buffer.alloc(0); break; }
          if (L.buf.length < size) break;
          const type = L.buf.readUInt8(2), payload = L.buf.slice(3, size);
          L.buf = L.buf.slice(size);
          if (type === 86) {
            if (payload.length >= 1 && payload.readUInt8(0) === 1) {
              const freq = Buffer.alloc(8); freq.writeDoubleBE(10, 0);
              sock.write(rtdeBericht(79, Buffer.concat([freq, Buffer.from("output_double_register_" + reg, "ascii")])));
            } else { log("slede", "RTDE-protocolversie 2 geweigerd — de stand van de slede lezen lukt niet op deze controller"); broadcast({ type: "error", message: "De controller ondersteunt RTDE versie 2 niet; de stand van de slede kan niet gelezen worden." }); }
          } else if (type === 79) {
            const types = payload.length > 1 ? payload.slice(1).toString("ascii") : "";
            if (!/DOUBLE/i.test(types)) { log("slede", `RTDE kent het register niet (${types || "leeg antwoord"})`); broadcast({ type: "error", message: "RTDE kent output_double_register_" + reg + " niet (antwoord: " + (types || "leeg") + ")." }); }
            else sock.write(rtdeBericht(83));
          } else if (type === 83) {
            log("slede", `stand van de slede wordt gelezen uit register ${reg}`);
          } else if (type === 85) {
            if (payload.length >= 9) {
              const mm = payload.readDoubleBE(1);
              if (isFinite(mm)) broadcast({ type: "asPositie", mm, register: reg });
              if (mm !== L.laatste) { if (L.laatste === null || Math.abs(mm - L.laatste) >= 1) log("slede", `register ${reg} = ${mm.toFixed(1)} mm`); L.laatste = mm; }
              if (mm === 0 && !L.nulGemeld && Date.now() - L.t0 > 6000) { L.nulGemeld = true; log("slede", `register ${reg} blijft 0 — het leesscript op de controller schrijft niets (daemon niet geïnitialiseerd, poort ${poort || "?"} onjuist, of script geweigerd)`); }
            }
          } else if (type === 77) {
            log("slede", `RTDE-melding: ${payload.toString("ascii")}`);
          }
        }
      });
      sock.on("error", err => log("slede", `RTDE-fout: ${err.message}`));
      sock.on("close", () => { if (!L.dood) setTimeout(verbind, 3000); });
    };
    verbind();
    const stuur = cmdStuur;
    L.timer = setInterval(stuur, 10000);
    stuur();
  }

  /* Digitale I/O met vaste frequentie naar de twin(s) sturen, net als de joints.
     Altijd sturen (niet alleen als laatsteIO gevuld is) met een expliciete
     rtdeVerbonden-vlag: zo ziet de twin zelf het verschil tussen "bridge
     online maar RTDE geeft nog geen data" en een echte livestand, in plaats
     van gewoon stil te blijven zonder enige melding in de interface.        */
  setInterval(() => {
    broadcast({ type: "io", rtdeVerbonden: !!laatsteIO, ...(laatsteIO || {}) });
  }, 1000 / ZEND_HZ);

  /* Schrijven gebeurt gewoon via URScript op de secondary interface (poort
     30002) — dezelfde weg als bewegingen en freedrive, geen aparte
     verbinding nodig. "extensie" = de configureerbare I/O (de extension-
     aansluiting); "standaard" = de vaste standaard digitale I/O.         */
  function stuurIOCommando(soort, nummer, waarde) {
    const functie = soort === "extensie" ? "set_configurable_digital_out" : "set_standard_digital_out";
    stuurURScript(`${functie}(${nummer}, ${waarde ? "True" : "False"})`);
  }

  /* ------------------ Programma-orchestratie ------------------
     Voert een reeks stappen op de robot uit:
     - "move"  : URScript-beweging via poort 30002 (zoals losse commando's)
     - "grip"  : een vooraf op de pendant opgeslagen .urp-programma
                 (bevat de OnRobot Grip-node) laden en afspelen via
                 het dashboard — dat is de enige manier waarop de
                 RG2-functie van de URCap beschikbaar is; een los
                 script naar poort 30002 kent die functie niet.
     Tussen elke stap wordt gewacht tot de robot niets meer draait
     voordat de volgende stap begint.                             */
  let programmaBezig = false;
  const URP_NAAM = /^[\w .\-]{1,80}\.urp$/i;     // alleen een gewone bestandsnaam: geen dashboard-commando's smokkelen
  let programmaAfbreken = false;

  async function wachtTotRobotKlaar(timeoutMs = 30000, opts = {}) {
    const { verifieerStart = false, startTimeoutMs = 9000 } = opts;
    /* OnRobot-apparaten (Eye/Compute Box) melden zich pas na het starten van
       een programma — dat kan volgens de UR-handleiding tot 5 s duren. Deze
       tijd moet daar ruim boven zitten, anders meldt de bridge "niet gestart"
       terwijl de grijper alleen nog maar even traag opstartte.              */
    if (verifieerStart) {
      /* Actief controleren dat de robot ook ECHT begonnen is, niet alleen
         aannemen dat hij klaar is — anders lijkt een stil mislukte start
         (load/play die geen effect had) precies op een geslaagde, razend-
         snelle uitvoering. Dat is exact wat "stap lijkt overgeslagen"
         veroorzaakt: running staat de hele tijd al op false.            */
      const t0 = Date.now();
      let gestart = false;
      while (Date.now() - t0 < startTimeoutMs) {
        if (programmaAfbreken) throw new Error("afgebroken door gebruiker");
        const antwoord = await dashboardVraag("running");
        if (/true/i.test(antwoord)) { gestart = true; break; }
        await new Promise(r => setTimeout(r, 100));
      }
      if (!gestart) {
        throw new Error(
          "programma is niet gestart — robot bleef 'running: false'. " +
          "Controleer: staat de robot op Remote (niet Local)? Staat de " +
          "schakelaar rechtsonder op Real Robot (niet Simulation)? Zijn " +
          "de remmen los?"
        );
      }
    } else {
      await new Promise(r => setTimeout(r, 350));      // even ruimte om de vorige start te laten inzetten
    }
    const start = Date.now();
    let laatstePopupPoging = 0;
    while (Date.now() - start < timeoutMs) {
      if (programmaAfbreken) throw new Error("afgebroken door gebruiker");
      const antwoord = await dashboardVraag("running");
      if (/false/i.test(antwoord)) return;
      /* Een popup op de pendant (bijv. van de OnRobot-URCap na een grijpactie)
         kan het programma laten "hangen" zonder dat running ooit false wordt.
         Elke ~1,5 s proberen we 'm zelf weg te klikken — onschuldig als er
         toch geen popup open staat, dan gebeurt er simpelweg niets.         */
      const nu = Date.now();
      if (nu - start > 1500 && nu - laatstePopupPoging > 1500) {
        laatstePopupPoging = nu;
        await dashboardVraag("close popup").catch(() => {});
      }
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error("time-out: robot bleef bezig (mogelijk een popup op de pendant die niet wegging)");
  }

  async function speelProgrammaAf(stappen) {
    if (programmaBezig) { broadcast({ type: "error", message: "Er draait al een programma." }); return; }
    programmaBezig = true; programmaAfbreken = false;
    for (let i = 0; i < stappen.length; i++) {
      const stap = stappen[i];
      broadcast({ type: "progvoortgang", i, totaal: stappen.length, status: "bezig", omschrijving: stap.omschrijving });
      try {
        if (programmaAfbreken) throw new Error("afgebroken door gebruiker");
        if (stap.soort === "move") {
          await wachtTotStil();                                   // eerst zeker weten dat de vorige beweging klaar is
          const qVoor = laatsteQ ? laatsteQ.slice() : null;
          stuurURScript(stap.script);
          await wachtTotBeweging(qVoor);                          // begint de arm echt te rijden?
          await wachtTotStil();                                   // en pas klaar als hij stilstaat
          await wachtTotRobotKlaar(8000).catch(() => {});
        } else if (stap.soort === "script") {
          await wachtTotStil();
          /* eigen URScript (bijv. een digitale uitgang voor een grijper), daarna een vaste wachttijd */
          if (typeof stap.script !== "string" || !stap.script.trim()) throw new Error("lege URScript-stap");
          stuurURScript(stap.script);
          await new Promise(r => setTimeout(r, Math.max(0, Math.min(15000, +stap.wacht || 1000))));
        } else if (stap.soort === "grip") {
          await wachtTotStil();                                   // grijper pas bedienen als de arm stilstaat
          if (typeof stap.open === "boolean") {
            await stuurGrijperCommando(stap.open, stap.kracht);
            const status = await wachtTotGrijperKlaar();
            broadcast({ type: "grijperstatus", ...status, open: stap.open });
          } else if (stap.programma) {
            if (!URP_NAAM.test(stap.programma)) throw new Error("ongeldige programmanaam voor de grijper: " + stap.programma);
            /* oude .urp-route — alleen nog voor programma's die van vóór de
               Modbus-aansturing zijn opgeslagen.                          */
            await dashboardVraag("stop").catch(() => {});
            await new Promise(r => setTimeout(r, 600));
            const laadAntwoord = await dashboardVraag("load " + stap.programma);
            if (/error|kan niet|not found|file not found/i.test(laadAntwoord))
              throw new Error("laden mislukt (" + laadAntwoord + ") — bestaat " + stap.programma + " in /programs?");
            const speelAntwoord = await dashboardVraag("play");
            if (/error|fail|could not|cannot/i.test(speelAntwoord))
              throw new Error("afspelen mislukt (" + speelAntwoord + ")");
            await wachtTotRobotKlaar(30000, { verifieerStart: true });
          }
        }
      } catch (err) {
        log("programma", `gestopt bij stap ${i + 1}: ${err.message}`);
        broadcast({ type: "progvoortgang", i, totaal: stappen.length, status: "fout", fout: err.message });
        programmaBezig = false;
        return;
      }
    }
    log("programma", "voltooid");
    broadcast({ type: "progvoortgang", i: stappen.length, totaal: stappen.length, status: "klaar" });
    programmaBezig = false;
  }

  /* ------------------ Netwerkcheck ------------------
     Op verzoek van de twin: lokale adapter, ping en poorttests.
     De browser mag zelf niet pingen; de bridge doet het en
     rapporteert terug.                                          */
  function testPoort(poort, naam) {
    return new Promise(resolve => {
      const s = net.createConnection({ host: robotIp, port: poort, timeout: 1500 });
      const klaar = ok => { s.destroy(); resolve({ naam, ok }); };
      s.on("connect", () => klaar(true));
      s.on("timeout", () => klaar(false));
      s.on("error",   () => klaar(false));
    });
  }

  async function netwerkCheck() {
    const r = [];

    // 1. lokale adapter in het robotsubnet?
    const subnet = robotIp.split(".").slice(0, 3).join(".");
    let eigenIP = null;
    for (const lijst of Object.values(os.networkInterfaces()))
      for (const a of lijst)
        if (a.family === "IPv4" && a.address.startsWith(subnet + ".")) eigenIP = a.address;
    r.push({ naam: `Eigen IP in ${subnet}.x`, ok: !!eigenIP,
             info: eigenIP || `geen adapter met ${subnet}.x gevonden — vast IP instellen` });

    // 2. ping naar de robot (systeemcommando, werkt op Windows en Linux)
    const pingCmd = process.platform === "win32"
      ? `ping -n 1 -w 1500 ${robotIp}` : `ping -c 1 -W 2 ${robotIp}`;
    const pingOk = await new Promise(res => exec(pingCmd, err => res(!err)));
    r.push({ naam: `Ping ${robotIp}`, ok: pingOk,
             info: pingOk ? "robot antwoordt" : "geen antwoord — kabel/IP controleren" });

    // 3. de vier robotpoorten
    r.push(await testPoort(RT_POORT,  `Poort ${RT_POORT} (uitlezen)`));
    r.push(await testPoort(CMD_POORT, `Poort ${CMD_POORT} (URScript)`));
    r.push(await testPoort(DASH_POORT,`Poort ${DASH_POORT} (dashboard)`));
    r.push(await testPoort(RTDE_POORT,`Poort ${RTDE_POORT} (digitale I/O)`));

    return r;
  }

  /* ------------------ Robot wisselen ------------------
     Wisselt alleen DEZE ene robot-sessie (en dus alleen de twins die op
     zíjn WS-poort zitten) naar een ander IP — de andere robots in deze
     bridge blijven gewoon draaien.                                     */
  function wisselRobot(ip) {
    if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
      broadcast({ type: "error", message: "Ongeldig IP-adres: " + ip });
      return;
    }
    log("bridge", `wissel naar robot ${ip}`);
    robotIp = ip;
    laatsteQ = null;
    laatsteIO = null;
    if (rtSocket)   rtSocket.destroy();    // close-handlers verbinden opnieuw,
    if (dashSocket) dashSocket.destroy();  // nu met het nieuwe robotIp
    if (rtdeSocket) rtdeSocket.destroy();
    broadcast({ type: "status", robot: "wisselen naar " + ip });
  }

  /* ------------------ Samen werken in AR ------------------
     Meerdere AR-apparaten (en/of de twin) kunnen tegelijk op dezelfde bridge zitten.
     De robotstand krijgt iedereen al. Dit deel regelt de rest:
       hallo {naam}            -> je doet mee; je krijgt een id en een kleur
       aanwezig {lijst, jij}   -> naar alle deelnemers: wie er nu is
       deel {soort, data}      -> wordt doorgegeven aan alle ANDEREN als {type:"deel", van, soort, data}
                                  (hoofd/handen, het programma met stappen). "programma" wordt onthouden,
                                  zodat wie later binnenkomt het meteen ziet.
       sessieSluiten           -> iedereen krijgt {type:"sessieGesloten", door}; de bridge zelf en de robot blijven gewoon aan
     Rollen: wie zich met hallo {rol:"host"} meldt, wordt host (als er nog geen is). Alleen de host kan
     de omgeving ("omgeving": robots, tafels, werkruimte) aanpassen en de sessie sluiten. Anderen zijn client:
     ze kunnen programma's maken en afspelen, en uitloggen.                                                 */
  const AR_KLEUREN = ["#E6007E", "#5AB8D4", "#3ECF8E", "#F5A623", "#9B7BFF", "#FFD84A", "#FF6B6B", "#7FD1FF"];
  const arDeelnemers = new Map();       // ws -> {id, naam, kleur}
  const arStaat = { programmas: {}, host: null, sessienaam: "" };   // programma's per robot, de omgeving, wie host is
  /* koppelingen: virtuele robot (slot-id, "r0" = de ijk-robot) -> nummer van de fysieke robot. De host (de laptop) legt ze vast;
     clients kunnen ze bekijken en, zolang de host dat toestaat, aanpassen. Ze blijven bewaard in een bestandje naast de bridge. */
  arStaat.koppelingen = {}; arStaat.clientKoppelen = true;
  arStaat.sessienaam = typeof OPTIES.naam === "string" ? OPTIES.naam.replace(/[^\p{L}\p{N} ._·-]/gu, "").trim().slice(0, 40) : "";
  const KOPPEL_BESTAND = path.join(process.cwd(), `ar-koppelingen-R${robotNr}.json`);
  if (OPTIES.schoon) { try { fs.unlinkSync(KOPPEL_BESTAND); } catch (e) { /* was er niet */ } }
  else try {
    const o = JSON.parse(fs.readFileSync(KOPPEL_BESTAND, "utf8"));
    if (o && typeof o.koppelingen === "object") { arStaat.koppelingen = o.koppelingen; arStaat.clientKoppelen = o.clientKoppelen !== false; }
  } catch (e) { /* nog geen bestand */ }
  function koppelSla() { try { fs.writeFileSync(KOPPEL_BESTAND, JSON.stringify({ koppelingen: arStaat.koppelingen, clientKoppelen: arStaat.clientKoppelen })); } catch (e) { /* niet erg */ } }
  function koppelPakket() {
    const lijst = { r0: robotNr, ...arStaat.koppelingen };     // de ijk-robot hoort standaard bij de robot van deze bridge
    for (const r of Object.keys(lijst)) if (lijst[r] === null) delete lijst[r];
    const fysiek = [...FYSIEK.values()].map(f => ({ nr: f.nr, naam: f.label, ip: f.ip(), poort: f.poort }));
    return { type: "koppelingen", lijst, fysiek, eigenNr: robotNr, clientKoppelen: arStaat.clientKoppelen, adres: omgevingPerRobot("BRIDGE_ADRES", robotNr, "") || lanAdres() };
  }
  let laatsteKoppelJson = "";
  function koppelStuur(allen) {
    const pak = JSON.stringify(koppelPakket());
    if (!allen && pak === laatsteKoppelJson) return;
    laatsteKoppelJson = pak;
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(pak); });
  }
  setInterval(() => koppelStuur(false), 3000);   // bijvoorbeeld als het IP van een robot verandert
  let arVolgNr = 0;
  const schoonNaam = n => String(n || "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 24);
  const arHostNaam = () => { const h = arStaat.host && arDeelnemers.get(arStaat.host); return h ? h.naam : ""; };
  function arLijst() { return [...arDeelnemers.entries()].map(([c, d]) => ({ id: d.id, naam: d.naam, kleur: d.kleur, host: c === arStaat.host })); }
  function arStuurAanwezig() {
    const lijst = arLijst();
    const hostId = arStaat.host && arDeelnemers.get(arStaat.host) ? arDeelnemers.get(arStaat.host).id : null;
    arDeelnemers.forEach((d, c) => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "aanwezig", lijst, jij: d.id, hostId, sessie: arStaat.sessienaam })); });
  }
  function arMelding(ws, tekst) { try { ws.send(JSON.stringify({ type: "melding", tekst })); } catch (e) { /* weg */ } }
  /* host worden: alleen als er nog geen (verbonden) host is */
  function arProbeerHost(ws, msg) {
    if (msg.rol !== "host") return;
    /* een nieuwe beheerder neemt het over (bijv. de serverpagina is herladen): de oude verbinding is dan meestal al weg */
    if (arStaat.host && arStaat.host !== ws && arDeelnemers.has(arStaat.host)) { arMelding(arStaat.host, "Een andere beheerder heeft de server overgenomen."); log("ar", "beheer overgenomen door " + arDeelnemers.get(ws).naam); }
    arStaat.host = ws;
    /* de naam van de server komt alleen uit de terminal (--naam=…); een pagina kan hem niet wijzigen */
    log("ar", `serverpagina (beheer) verbonden${arStaat.sessienaam ? ` — server “${arStaat.sessienaam}”` : ""}`);
  }
  function arVerwerk(ws, msg) {
    if (msg.type === "hallo") {
      if (arDeelnemers.has(ws)) { arDeelnemers.get(ws).naam = schoonNaam(msg.naam) || arDeelnemers.get(ws).naam; arProbeerHost(ws, msg); arStuurAanwezig(); return true; }
      const gebruikt = new Set([...arDeelnemers.values()].map(d => d.kleur));
      const kleur = AR_KLEUREN.find(k => !gebruikt.has(k)) || AR_KLEUREN[arVolgNr % AR_KLEUREN.length];
      const id = ++arVolgNr;
      const naam = schoonNaam(msg.naam) || ("Deelnemer " + id);
      arDeelnemers.set(ws, { id, naam, kleur });
      arProbeerHost(ws, msg);
      if (arStaat.host !== ws) { const n = [...arDeelnemers.keys()].filter(c => c !== arStaat.host).length; log("ar", `client ${naam} doet mee (${n} client${n === 1 ? "" : "s"})`); }
      arStuurAanwezig();
      if (arStaat.omgeving) ws.send(JSON.stringify({ type: "deel", van: 0, soort: "omgeving", data: arStaat.omgeving }));
      for (const [id, doel] of Object.entries(arStaat.sleden || {})) ws.send(JSON.stringify({ type: "deel", van: 0, soort: "slede", data: { id, doel } }));
      for (const [r, stappen] of Object.entries(arStaat.programmas)) ws.send(JSON.stringify({ type: "deel", van: 0, soort: "programma", data: { r, stappen } }));
      ws.send(JSON.stringify(koppelPakket()));
      return true;
    }
    const ik = arDeelnemers.get(ws);
    if (msg.type === "deel" && ik && typeof msg.soort === "string" && /^[a-z]{1,20}$/.test(msg.soort)) {
      if (JSON.stringify(msg.data || null).length > 200000) return true;
      if (msg.soort === "omgeving") {              // alleen de host past de omgeving aan
        if (arStaat.host !== ws) { arMelding(ws, "Alleen de serverpagina (beheer) kan de omgeving aanpassen."); return true; }
        if (msg.data && Array.isArray(msg.data.items)) arStaat.omgeving = msg.data; else delete arStaat.omgeving;
      }
      if (msg.soort === "programma" && msg.data) {  // per robot onthouden (oudere viewers sturen alleen een lijst: dat is robot r0)
        const r = Array.isArray(msg.data) ? "r0" : String(msg.data.r || "r0").slice(0, 40);
        const stappen = Array.isArray(msg.data) ? msg.data : msg.data.stappen;
        if (Array.isArray(stappen)) arStaat.programmas[r] = stappen;
      }
      if (msg.soort === "slede" && msg.data && typeof msg.data.id === "string" && isFinite(+msg.data.doel)) (arStaat.sleden ||= {})[msg.data.id.slice(0, 40)] = +msg.data.doel;   // wie later binnenkomt ziet de rail waar hij nu naartoe gaat
      const uit = JSON.stringify({ type: "deel", van: ik.id, soort: msg.soort, data: msg.data });
      arDeelnemers.forEach((d, c) => { if (c !== ws && c.readyState === WebSocket.OPEN) c.send(uit); });
      return true;
    }
    if (msg.type === "koppel" && ik) {            // {r, nr}: nr = nummer van de fysieke robot, of null om los te koppelen
      const isHost = arStaat.host === ws;
      if (!isHost && !arStaat.clientKoppelen) { arMelding(ws, "De host staat niet toe dat clients koppelingen aanpassen."); koppelStuur(true); return true; }
      const r = String(msg.r || "").slice(0, 40);
      const nr = msg.nr === null ? null : +msg.nr;
      if (!r || (nr !== null && !FYSIEK.has(nr))) { arMelding(ws, "Die koppeling bestaat niet."); return true; }
      if (nr !== null) for (const k of Object.keys(arStaat.koppelingen)) if (arStaat.koppelingen[k] === nr && k !== r) arStaat.koppelingen[k] = null;
      if (nr !== null && nr === robotNr && r !== "r0" && !("r0" in arStaat.koppelingen)) arStaat.koppelingen.r0 = null;   // de eigen robot gaat naar r
      arStaat.koppelingen[r] = nr;
      log("ar", `${ik.naam}: ${r} ${nr === null ? "losgekoppeld" : "gekoppeld aan R" + nr}`);
      koppelSla(); koppelStuur(true);
      const tekst = `${ik.naam} koppelde ${r === "r0" ? "de ijk-robot" : r} ${nr === null ? "los" : "aan R" + nr}`;
      arDeelnemers.forEach((d, c) => { if (c !== ws && c.readyState === WebSocket.OPEN) arMelding(c, tekst); });
      return true;
    }
    if (msg.type === "koppelRechten" && ik) {      // alleen de host: mogen clients koppelingen aanpassen?
      if (arStaat.host !== ws) { arMelding(ws, "Alleen de serverpagina (beheer) bepaalt of clients koppelingen mogen aanpassen."); return true; }
      arStaat.clientKoppelen = !!msg.aan; koppelSla(); koppelStuur(true);
      return true;
    }
    if (msg.type === "sessieSluiten") {
      if (arStaat.host !== ws) { arMelding(ws, "Alleen de serverpagina (beheer) kan de sessie sluiten. Je kunt wel uitloggen."); return true; }
      const door = ik ? ik.naam : "iemand";
      log("ar", `sessie gesloten door ${door}`);
      const uit = JSON.stringify({ type: "sessieGesloten", door });
      wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(uit); });
      arStaat.programmas = {}; arStaat.sleden = {}; delete arStaat.omgeving; arStaat.host = null; arStaat.sessienaam = ""; /* de koppelingen blijven staan voor de volgende sessie */
      return true;
    }
    return false;
  }

  /* ------------------ Aanmelden voor "sessies in de buurt" ------------------
     Een browser kan zelf niet zoeken in het netwerk. Daarom meldt deze bridge zich elke 5 seconden
     aan bij de sessie-server (session-server.js, standaard op deze laptop, poort 9290). De AR-pagina
     vraagt daar de lijst op en kan dan direct meedoen. Geen sessie-server? Dan werkt alles
     gewoon, alleen het zoeken niet (de bridge meldt dat één keer).
       SESSIESERVER      adres van de sessie-server (standaard http://localhost:9290, leeg = niet aanmelden)
       BRIDGE_ADRES      het adres waarmee anderen deze bridge bereiken (standaard het LAN-adres van deze laptop)
       AR_SESSIENAAM     de naam in de lijst (standaard "<computernaam> · robot N")                       */
  const REGISTER = String(omgevingPerRobot("SESSIESERVER", robotNr, "http://localhost:9290") || "").replace(/\/$/, "");
  function lanAdres() {
    const kand = [];
    for (const lijst of Object.values(os.networkInterfaces())) for (const i of lijst || []) if (i.family === "IPv4" && !i.internal) kand.push(i.address);
    return kand.find(a => /^192\.168\./.test(a)) || kand.find(a => /^10\./.test(a)) || kand.find(a => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) || kand[0] || "localhost";
  }
  const sessieInfo = host => ({
    id: `${os.hostname()}-${wsPoort}`,
    naam: arStaat.sessienaam || omgevingPerRobot("AR_SESSIENAAM", robotNr, "") || `${os.hostname()} · robot ${robotNr}`,
    host: arHostNaam() || os.hostname(),         // de bridge zelf is de server: hij staat in de lijst zodra hij draait
    wsUrl: `${heeftCertificaat ? "wss" : "ws"}://${host}:${wsPoort}`,
    robot: robotIp,
    deelnemers: [...arDeelnemers.entries()].filter(([c]) => c !== arStaat.host).map(([, d]) => d.naam),   // de server (laptop) is geen speler
  });
  SESSIE_INFO.set(wsPoort, sessieInfo);
  SESSIE_AFMELD.push(() => {
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "melding", tekst: "De server (bridge) wordt gestopt" })); });
    if (!registerNu) return;
    const url = new URL(registerNu + "/ar-sessies/afmelden"), body = JSON.stringify({ id: `${os.hostname()}-${wsPoort}` });
    const req = (url.protocol === "https:" ? https : http).request(url, { method: "POST", timeout: 1500, rejectUnauthorized: false, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, r => r.resume());
    req.on("error", () => {}); req.end(body);
  });
  let aanmeldFout = false, registerNu = REGISTER;
  function meldAan() {
    if (!registerNu) return;
    try {
      const url = new URL(registerNu + "/ar-sessies/aanmelden");
      const host = omgevingPerRobot("BRIDGE_ADRES", robotNr, "") || lanAdres();
      const body = JSON.stringify(sessieInfo(host));
      const mod = url.protocol === "https:" ? https : http;
      const req = mod.request(url, { method: "POST", timeout: 2500, rejectUnauthorized: false,      // eigen certificaat op het eigen netwerk
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => {
        res.resume();
        if (aanmeldFout) { aanmeldFout = false; log("ar", "aangemeld bij de sessie-server"); }
      });
      req.on("error", () => {
        /* draait de sessie-server met https (of juist http)? Probeer de andere variant bij de volgende keer */
        registerNu = registerNu.startsWith("https:") ? registerNu.replace(/^https:/, "http:") : registerNu.replace(/^http:/, "https:");
        if (!aanmeldFout) { aanmeldFout = true; log("ar", `sessie-server (${REGISTER}) niet bereikbaar — niet erg: clients vinden deze server ook via het IP-adres van deze laptop (GET /ar-sessies op poort ${wsPoort})`); }
      });
      req.on("timeout", () => req.destroy());
      req.end(body);
    } catch (e) { /* ongeldig adres: negeren */ }
  }
  setInterval(meldAan, 5000); setTimeout(meldAan, 1500);

  /* ------------------ Berichten van de twin ------------------ */
  let freedriveDoor = null;       // wie freedrive aanzette: valt die weg (bril af, wifi weg), dan zet de bridge freedrive uit
  wss.on("connection", ws => {
    log("twin", "verbonden");
    ws.on("close", () => { if (freedriveDoor === ws) { freedriveDoor = null; stuurURScript(FREEDRIVE_UIT); log("robot", "freedrive UIT (de verbinding die het aanzette is weg)"); broadcast({ type: "freedriveStatus", aan: false }); } });
    ws.on("message", data => {
      let msg;
      try { msg = JSON.parse(data); } catch { return; }
      if (arVerwerk(ws, msg)) return;
      if (msg.type === "urscript" && typeof msg.script === "string") {
        stuurURScript(msg.script);
      }
      if (msg.type === "asRegisters") {
        if (msg.aan) { if (!slReg || slReg.base !== Math.round(+msg.register || 24) || slReg.modus !== slMod(msg) || slReg.poort !== Math.round(+msg.poort || 30405)) startSlideRegisters(msg.register, slMod(msg), msg.poort); }
        else stopSlideRegisters();
        if (msg.aan && slMod(msg) === "register" && msg.programma) startProgramma(msg.programma); else stopProgramma();
      }
      if (msg.type === "asOpdracht" && slReg) {
        slReg.stuur(+msg.doel, +msg.id, +msg.snelheid, +msg.acc, +msg.dec);
        log("slede", `opdracht ${msg.id}: naar ${(+msg.doel).toFixed(1)} mm (snelheid ${msg.snelheid}, acc ${msg.acc}, dec ${msg.dec})`);
      }
      if (msg.type === "asLees") {
        if (msg.aan) startSlideLezer(msg.register, msg.functie || "get_slidekit_position()", msg.ms, msg.poort);
        else stopSlideLezer();
      }
      if (msg.type === "dashboard" && DASH_TOEGESTAAN.has(msg.cmd)) {
        stuurDashboard(msg.cmd);
      }
      if (msg.type === "freedrive") {
        if (msg.aan && programmaBezig) { ws.send(JSON.stringify({ type: "melding", tekst: "Freedrive kan niet aan: er draait een programma op de robot." })); return; }
        stuurURScript(msg.aan ? FREEDRIVE_AAN : FREEDRIVE_UIT);
        freedriveDoor = msg.aan ? ws : null;
        log("robot", `freedrive ${msg.aan ? "AAN" : "UIT"}`);
        broadcast({ type: "freedriveStatus", aan: !!msg.aan });
      }
      if (msg.type === "netcheck") {
        log("bridge", "netwerkcheck gestart …");
        netwerkCheck().then(res => {
          res.forEach(x => log("check", `${x.ok ? "OK  " : "FOUT"} ${x.naam}${x.info ? " — " + x.info : ""}`));
          ws.send(JSON.stringify({ type: "netcheck", robotIP: robotIp, resultaten: res }));
        });
      }
      if (msg.type === "setRobot" && typeof msg.ip === "string") {
        wisselRobot(msg.ip.trim());
      }
      if (msg.type === "programma" && Array.isArray(msg.stappen)) {
        const wie = arDeelnemers.get(ws);
        if (wie) { log("programma", `${wie.naam} stuurt het programma naar de robot`); arDeelnemers.forEach((d, c) => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: "melding", tekst: `${wie.naam} stuurde het programma naar de robot` })); }); }
        log("programma", `gestart (${msg.stappen.length} stappen)`);
        speelProgrammaAf(msg.stappen);
      }
      if (msg.type === "programmaStop") {
        programmaAfbreken = true;
        stuurDashboard("stop");
        log("programma", "stopcommando ontvangen");
      }
      if (msg.type === "grijperCommando" && typeof msg.open === "boolean") {
        stuurGrijperCommando(msg.open, msg.kracht)
          .then(() => wachtTotGrijperKlaar())
          .then(status => broadcast({ type: "grijperstatus", ...status, open: msg.open }))
          .catch(err => {
            log("grijper", `fout: ${err.message}`);
            broadcast({ type: "error", message: "Grijper: " + err.message });
          });
      }
      if (msg.type === "grijperProgramma" && typeof msg.programma === "string") {
        /* Grijper via de OnRobot-URCap (robot zonder Eye Box): een op de pendant
           opgeslagen .urp-programma laden en afspelen via het dashboard.     */
        (async () => {
          if (!URP_NAAM.test(msg.programma)) { broadcast({ type: "error", message: "Ongeldige programmanaam voor de grijper: " + msg.programma }); return; }
          if (programmaBezig) { broadcast({ type: "error", message: "Er draait al een programma." }); return; }
          programmaBezig = true; programmaAfbreken = false;
          try {
            await dashboardVraag("stop").catch(() => {});                 // vorig programma echt laten stoppen
            await new Promise(r => setTimeout(r, 600));
            const laad = await dashboardVraag("load " + msg.programma);
            if (/error|kan niet|not found|file not found/i.test(laad)) throw new Error("laden mislukt (" + laad + ") — bestaat " + msg.programma + " in /programs?");
            const speel = await dashboardVraag("play");
            if (/error|fail|could not|cannot/i.test(speel)) throw new Error("afspelen mislukt (" + speel + ")");
            await wachtTotRobotKlaar(30000, { verifieerStart: true });
            if (typeof msg.open === "boolean") broadcast({ type: "grijperstatus", open: msg.open });
          } catch (err) {
            log("grijper", `fout: ${err.message}`);
            broadcast({ type: "error", message: "Grijper (URCap): " + err.message });
          } finally { programmaBezig = false; }
        })();
      }
      if (msg.type === "grijperReset") {
        grijperReset()
          .then(status => { grijperFoutBitGemeld = false; broadcast({ type: "grijperstatus", ...status }); log("grijper", "verbinding opnieuw opgebouwd, stopcommando gestuurd"); })
          .catch(err => broadcast({ type: "error", message: "Grijper resetten mislukt: " + err.message }));
      }
      if (msg.type === "grijperStroomReset") {
        /* Gripper (en Eye Box) stroomloos maken via de gereedschapsspanning van de robot:
           set_tool_voltage(0) → wachten → set_tool_voltage(24). Werkt alleen als de
           gripper/Eye Box zijn stroom van de tool-aansluiting van de UR krijgt.     */
        (async () => {
          const meld = (fase, tekst, ok) => { log("grijper", tekst); broadcast({ type: "grijperreset", fase, tekst, ok }); };
          if (programmaBezig) { broadcast({ type: "error", message: "Er draait al een programma." }); return; }
          programmaBezig = true;
          try {
            meld("bezig", "Stroom uit: gereedschapsspanning 0 V…");
            stuurURScript("set_tool_voltage(0)");
            await new Promise(r => setTimeout(r, 4000));
            if (msg.eyebox) {
              /* Controle: ging de Eye Box ECHT uit? Zo niet, dan krijgt hij zijn stroom niet via de robot. */
              await sluitGrijperVerbinding();
              const nogAan = await Promise.race([
                leesGrijperStatusRuw().then(() => true, () => false),
                new Promise(r => setTimeout(() => r(false), 3500))
              ]);
              await sluitGrijperVerbinding();
              if (nogAan) meld("bezig", "Let op: de Eye Box bleef bereikbaar zonder gereedschapsspanning — hij krijgt zijn stroom waarschijnlijk niet via de robot. Reset zo niet mogelijk; schakel de voeding van de Eye Box.", false);
              else meld("bezig", "Eye Box is uit gegaan (stroom via de robot werkt). Nu weer aan…");
            }
            stuurURScript("set_tool_voltage(24)");
            meld("bezig", "Stroom aan: gereedschapsspanning 24 V. Wachten tot de grijper opstart…");
            if (msg.eyebox) {
              const t0 = Date.now();
              let laatste = "";
              while (Date.now() - t0 < 75000) {                 // de Eye Box heeft tijd nodig om op te starten
                await new Promise(r => setTimeout(r, 3000));
                try {
                  await sluitGrijperVerbinding(); const st = await leesGrijperStatusRuw();
                  grijperFoutBitGemeld = false; broadcast({ type: "grijperstatus", ...st });
                  meld("klaar", "Klaar: de grijper is weer bereikbaar na " + Math.round((Date.now() - t0)/1000) + " s.", true);
                  return;
                } catch (e) { laatste = e.message; }
              }
              throw new Error("grijper niet weer bereikbaar na 75 s (" + laatste + ")");
            }
            await new Promise(r => setTimeout(r, 5000));
            meld("klaar", "Klaar: gereedschapsspanning staat weer aan. Start het grijperprogramma op de pendant opnieuw.", true);
          } catch (err) {
            meld("fout", "Stroom uit/aan mislukt: " + err.message, false);
            broadcast({ type: "error", message: "Grijper stroom uit/aan: " + err.message });
          } finally { programmaBezig = false; }
        })();
      }
      if (msg.type === "grijperStatus") {
        leesGrijperStatus()
          .then(status => ws.send(JSON.stringify({ type: "grijperstatus", ...status })))
          .catch(err => ws.send(JSON.stringify({ type: "error", message: "Grijperstatus lezen mislukt: " + err.message })));
      }
      if (msg.type === "ioCommando"
          && (msg.soort === "standaard" || msg.soort === "extensie")
          && Number.isInteger(msg.nummer) && msg.nummer >= 0 && msg.nummer <= 7
          && typeof msg.waarde === "boolean") {
        stuurIOCommando(msg.soort, msg.nummer, msg.waarde);
      }
    });
    ws.on("close", () => {
      log("twin", "verbinding gesloten");
      if (arStaat.host === ws) { arStaat.host = null; log("ar", "de host is weg; de sessie blijft bestaan tot iemand opnieuw host wordt of de bridge stopt"); }
      if (arDeelnemers.delete(ws)) { log("ar", `deelnemer weg (${arDeelnemers.size} over)`); arStuurAanwezig(); }
      if (![...wss.clients].some(c => c !== ws && c.readyState === WebSocket.OPEN)) stopProgramma();   // pas stoppen als niemand meer verbonden is
    });
  });
}

/* ============================================================
   IP-adressen bepalen: via parameters, of anders interactief
   ============================================================ */

/* Vraagt IP-adressen één voor één op via de terminal; een lege regel
   (gewoon Enter) sluit de lijst af. Zo hoeft niemand te onthouden hoe de
   parameters precies moeten — typen en Enter volstaat.                */
function vraagIPsInteractief() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ips = [];
    console.log("Geen IP-adressen meegegeven bij het starten.");
    console.log("Voer de robot-IP's één voor één in en druk op Enter; een lege regel sluit de lijst af.\n");
    function volgende() {
      rl.question(`  Robot ${ips.length + 1} — IP-adres (leeg = klaar): `, antwoord => {
        const ip = antwoord.trim();
        if (!ip) { rl.close(); resolve(ips); return; }
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
          console.log(`  "${ip}" ziet er niet uit als een IP-adres (bijv. 192.168.1.100) — probeer opnieuw.`);
        } else {
          ips.push(ip);
        }
        volgende();
      });
    }
    volgende();
  });
}

async function bepaalRobotIPs() {
  const argsIPs = POS_ARGS;
  if (argsIPs.length > 0) return argsIPs;
  const ips = await vraagIPsInteractief();
  if (ips.length === 0) {
    console.log("Geen enkel IP-adres opgegeven — de bridge stopt. Start opnieuw en voer minstens één IP in, of geef het mee als parameter.");
    process.exit(1);
  }
  return ips;
}

/* netjes stoppen: clients krijgen een melding en de server verdwijnt direct uit de lijst */
let stopt = false;
function netStoppen() {
  if (stopt) process.exit(0);
  stopt = true;
  console.log("\n[bridge] stopt …");
  for (const f of SESSIE_AFMELD) { try { f(); } catch (e) { /* weg */ } }
  setTimeout(() => process.exit(0), 400);
}
process.on("SIGINT", netStoppen); process.on("SIGTERM", netStoppen);
(async () => {
  const robotIPs = await bepaalRobotIPs();
  const poortTot = WS_POORT_BASIS + robotIPs.length - 1;
  console.log(`\n[bridge] start ${robotIPs.length} robot${robotIPs.length === 1 ? "" : "s"}: ${robotIPs.join(", ")}`);
  console.log(`[bridge] WS-poort${robotIPs.length === 1 ? "" : "en"}: ${WS_POORT_BASIS}${robotIPs.length > 1 ? "–" + poortTot : ""} (robot 1 → ${WS_POORT_BASIS}, robot 2 → ${WS_POORT_BASIS + 1}, …)\n`);
  robotIPs.forEach((ip, i) => startRobotBridge(ip, i + 1, WS_POORT_BASIS + i));
})();