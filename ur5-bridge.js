/* ============================================================
   UR5 BRIDGE  —  koppelt de digital twin (browser) aan de echte UR5
   ============================================================
   De browser kan zelf geen TCP-verbinding openen; dit script wel.
   Het leest de realtime-interface van de robot (poort 30003) en
   geeft de gewrichtshoeken via WebSocket door aan de twin.
   URScript-commando's uit de twin worden doorgestuurd naar
   poort 30002 (secondary interface).

   INSTALLATIE (eenmalig, op de pc die aan de robot hangt):
     1. Installeer Node.js (nodejs.org, LTS-versie).
     2. Open een terminal in deze map en voer uit:
          npm install ws modbus-serial
     3. Pas hieronder ROBOT_IP aan (zie teach pendant:
        Instellingen → Systeem → Netwerk).

   STARTEN:
          node ur5-bridge.js
     Open daarna ur5-digital-twin.html en klik "Verbinden"
     (adres: ws://localhost:9090, of ws://<ip-van-deze-pc>:9090
     als de twin op een andere computer draait).

   NETWERK (directe ethernetkabel):
     Geef de robot en de pc een vast IP in hetzelfde subnet,
     robot 192.168.1.100 / pc bijv. 192.168.1.20, masker 255.255.255.0.

   OP AFSTAND BEREIKBAAR MAKEN (wss:// direct vanuit dit script):
     Zet een certificaat en sleutel naast dit bestand als cert.pem
     en key.pem (of geef andere paden mee via de omgevingsvariabelen
     TLS_CERT en TLS_KEY). Staan die er, dan start de bridge zelf al
     beveiligd op wss://; ontbreken ze, dan draait hij gewoon zoals
     altijd op onbeveiligd ws:// (prima voor lokaal testen).
   ============================================================ */

const net = require("net");
const fs = require("fs");
const https = require("https");
const WebSocket = require("ws");

/* ------------------ INSTELLINGEN ------------------ */
let ROBOT_IP = process.argv[2] || "192.168.1.100";   // IP van de robot
/* Ander IP? Start met:  node ur5-bridge.js 192.168.192.4
   of wissel tijdens gebruik via de twin (knop "Wissel robot"). */
const RT_POORT   = 30003;            // realtime interface (uitlezen, 125 Hz)
const CMD_POORT  = 30002;            // secondary interface (URScript sturen)
const WS_POORT   = 9090;             // poort waarop de twin verbindt
const ZEND_HZ    = 15;               // hoe vaak joints naar de twin gaan
const TLS_CERT   = process.env.TLS_CERT || "cert.pem";
const TLS_KEY    = process.env.TLS_KEY  || "key.pem";
/* --------------------------------------------------- */

/* WebSocket-server voor de twin(s) — automatisch wss:// als er een
   certificaat + sleutel klaarstaan, anders gewoon ws:// zoals altijd. */
let wss;
const heeftCertificaat = fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY);
if (heeftCertificaat) {
  const httpsServer = https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key:  fs.readFileSync(TLS_KEY),
  });
  wss = new WebSocket.Server({ server: httpsServer });
  httpsServer.listen(WS_POORT, () => {
    console.log(`[bridge] beveiligde WebSocket-server actief op wss://<dit-adres>:${WS_POORT}`);
  });
  httpsServer.on("error", err => console.log(`[bridge] kon niet starten op poort ${WS_POORT}: ${err.message}`));
} else {
  wss = new WebSocket.Server({ port: WS_POORT });
  console.log(`[bridge] WebSocket-server actief op ws://localhost:${WS_POORT}`);
  console.log(`[bridge] (onbeveiligd — leg ${TLS_CERT} en ${TLS_KEY} naast dit bestand voor wss://)`);
}
console.log(`[bridge] robot-IP: ${ROBOT_IP}  (wijzigen: node ur5-bridge.js <ip>)`);

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

function verbindRealtime() {
  rtSocket = net.createConnection(RT_POORT, ROBOT_IP, () => {
    console.log(`[robot] verbonden met ${ROBOT_IP}:${RT_POORT}`);
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
      }
    }
  });

  rtSocket.on("error", err => console.log(`[robot] fout: ${err.message}`));
  rtSocket.on("close", () => {
    console.log("[robot] verbinding verbroken — opnieuw proberen over 3 s");
    broadcast({ type: "status", robot: "verbroken" });
    laatsteQ = null;
    setTimeout(verbindRealtime, 3000);
  });
}
verbindRealtime();

/* Joints met vaste frequentie naar de twin sturen */
setInterval(() => {
  if (laatsteQ) broadcast({ type: "joints", q: laatsteQ });
}, 1000 / ZEND_HZ);

/* ------------------ Sturen: poort 30002 ------------------ */
function stuurURScript(script) {
  const cmd = net.createConnection(CMD_POORT, ROBOT_IP, () => {
    cmd.write(script + "\n");
    cmd.end();
    console.log(`[robot] URScript verstuurd: ${script.split("\n")[0]} ...`);
  });
  cmd.on("error", err => {
    console.log(`[robot] versturen mislukt: ${err.message}`);
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
const ModbusRTU = require("modbus-serial");
const GRIJPER_IP = process.env.GRIJPER_IP || "192.168.1.1";
const GRIJPER_POORT = +(process.env.GRIJPER_POORT || 502);
const GRIJPER_UNIT = 65;
const GRIJPER_MECHANISCH_MAX = 1100;   // RG2 = 1100 (110,0 mm); voor een RG6 is dit 1600 — puur de fysieke grens
const GRIJPER_OPEN_BREEDTE = +(process.env.GRIJPER_OPEN_MM ? process.env.GRIJPER_OPEN_MM * 10 : 1050);
/* Standaard net iets onder het mechanische maximum (105,0 i.p.v. 110,0 mm) —
   helemaal tot de fysieke aanslag sturen geeft soms een klein "terugveer"-
   correctiebewegingetje van de motor zelf. Andere waarde nodig? Start de
   bridge met bijv. GRIJPER_OPEN_MM=100 node ur5-bridge.js                */
const GRIJPER_MAX_KRACHT  = 400;    // RG2 = 400 (40,0 N); voor een RG6 wordt dit 1200
const modbusClient = new ModbusRTU();
let grijperVerbonden = false;

async function zorgVoorGrijperVerbinding() {
  if (grijperVerbonden) return;
  await modbusClient.connectTCP(GRIJPER_IP, { port: GRIJPER_POORT });
  modbusClient.setID(GRIJPER_UNIT);
  modbusClient.setTimeout(2000);
  grijperVerbonden = true;
  console.log(`[grijper] Modbus-verbinding actief met ${GRIJPER_IP}:${GRIJPER_POORT}`);
}

async function leesGrijperStatus() {
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

async function stuurGrijperCommando(open, krachtN) {
  await zorgVoorGrijperVerbinding();
  const kracht10 = Number.isFinite(krachtN)
    ? Math.max(0, Math.min(GRIJPER_MAX_KRACHT, Math.round(krachtN * 10)))
    : GRIJPER_MAX_KRACHT;
  const breedte10 = open ? GRIJPER_OPEN_BREEDTE : 0;
  await modbusClient.writeRegisters(0, [kracht10, breedte10, 16]);   // 16 = grip met fingertip-offset
}

async function wachtTotGrijperKlaar(timeoutMs = 8000) {
  const start = Date.now();
  await new Promise(r => setTimeout(r, 150));   // even ruimte om "bezig" te laten inzetten
  while (Date.now() - start < timeoutMs) {
    if (programmaAfbreken) throw new Error("afgebroken door gebruiker");
    const status = await leesGrijperStatus();
    if (status.veiligheidsfout){
      const reden = status.foutBijInschakelen
        ? "een schakelaar stond al ingedrukt toen de grijper werd ingeschakeld (niet per se nu ontstaan)"
        : status.s1Getriggerd && status.s2Getriggerd ? "beide veiligheidsschakelaars (S1 én S2) geactiveerd tijdens een beweging"
        : status.s1Getriggerd ? "veiligheidsschakelaar S1 geactiveerd tijdens een beweging"
        : "veiligheidsschakelaar S2 geactiveerd tijdens een beweging";
      throw new Error("grijper-veiligheidsschakelaar geactiveerd (" + reden + ") — reset vereist stroom uit/aan van de grijper");
    }
    if (!status.bezig) return status;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("time-out: grijper bleef bezig");
}

/* ------------------ Dashboard: poort 29999 ------------------
   Tekstcommando's voor robotbeheer: "power on", "brake release",
   "power off", "robotmode", "unlock protective stop", enz.
   Vereist op de e-Series: Remote Control ingeschakeld én de
   robot in Remote-stand (rechtsboven op de pendant).          */
const DASH_POORT = 29999;
let dashSocket = null;
let dashBuffer = "";
let dashWachters = [];               // FIFO: opeenvolgende dashboard-antwoorden horen bij opeenvolgende vragen

function verbindDashboard() {
  dashSocket = net.createConnection(DASH_POORT, ROBOT_IP, () => {
    console.log(`[dashboard] verbonden met ${ROBOT_IP}:${DASH_POORT}`);
  });
  dashSocket.on("data", chunk => {
    dashBuffer += chunk.toString();
    let i;
    while ((i = dashBuffer.indexOf("\n")) >= 0) {
      const regel = dashBuffer.slice(0, i).trim();
      dashBuffer = dashBuffer.slice(i + 1);
      if (regel) {
        console.log(`[dashboard] ${regel}`);
        broadcast({ type: "dashboard", antwoord: regel });
        if (dashWachters.length) dashWachters.shift()(regel);   // koppel aan oudste openstaande vraag
      }
    }
  });
  dashSocket.on("error", err => console.log(`[dashboard] fout: ${err.message}`));
  dashSocket.on("close", () => {
    console.log("[dashboard] verbinding verbroken — opnieuw proberen over 3 s");
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
    console.log(`[dashboard] > ${cmd}`);
  } else {
    broadcast({ type: "error", message: "Dashboard niet verbonden." });
  }
}

/* Stuurt een dashboardcommando en wacht op precies dat ene antwoord.
   Werkt omdat de dashboard-server op één verbinding altijd in
   volgorde antwoordt — zolang wij ook in volgorde vragen.       */
function dashboardVraag(cmd, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    if (!dashSocket || dashSocket.destroyed) { reject(new Error("dashboard niet verbonden")); return; }
    const timer = setTimeout(() => reject(new Error("time-out op: " + cmd)), timeoutMs);
    dashWachters.push(regel => {
      clearTimeout(timer);
      if (regel === "__VERBROKEN__") reject(new Error("dashboardverbinding verbroken tijdens: " + cmd));
      else resolve(regel);
    });
    dashSocket.write(cmd + "\n");
    console.log(`[dashboard] > ${cmd}`);
  });
}

/* Alleen deze beheercommando's zijn toegestaan (whitelist) */
const DASH_TOEGESTAAN = new Set([
  "power on", "power off", "brake release", "robotmode",
  "unlock protective stop", "safetystatus", "stop", "close popup"
]);

/* ------------------ Freedrive via URScript ------------------
   Start: programma dat freedrive aanzet en blijft draaien.
   Stop:  leeg programma versturen — dat vervangt het draaiende
   programma, waarmee freedrive automatisch eindigt.           */
const FREEDRIVE_AAN =
  "def fdrive():\n  freedrive_mode()\n  while (True):\n    sync()\n  end\nend";
const FREEDRIVE_UIT =
  "def fstop():\n  end_freedrive_mode()\nend";

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
        stuurURScript(stap.script);
        await wachtTotRobotKlaar();
      } else if (stap.soort === "grip") {
        if (typeof stap.open === "boolean") {
          await stuurGrijperCommando(stap.open, stap.kracht);
          const status = await wachtTotGrijperKlaar();
          broadcast({ type: "grijperstatus", ...status, open: stap.open });
        } else if (stap.programma) {
          /* oude .urp-route — alleen nog voor programma's die van vóór de
             Modbus-aansturing zijn opgeslagen.                          */
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
      console.log(`[programma] gestopt bij stap ${i + 1}: ${err.message}`);
      broadcast({ type: "progvoortgang", i, totaal: stappen.length, status: "fout", fout: err.message });
      programmaBezig = false;
      return;
    }
  }
  console.log("[programma] voltooid");
  broadcast({ type: "progvoortgang", i: stappen.length, totaal: stappen.length, status: "klaar" });
  programmaBezig = false;
}

/* ------------------ Netwerkcheck ------------------
   Op verzoek van de twin: lokale adapter, ping en poorttests.
   De browser mag zelf niet pingen; de bridge doet het en
   rapporteert terug.                                          */
const os = require("os");
const { exec } = require("child_process");

function testPoort(poort, naam) {
  return new Promise(resolve => {
    const s = net.createConnection({ host: ROBOT_IP, port: poort, timeout: 1500 });
    const klaar = ok => { s.destroy(); resolve({ naam, ok }); };
    s.on("connect", () => klaar(true));
    s.on("timeout", () => klaar(false));
    s.on("error",   () => klaar(false));
  });
}

async function netwerkCheck() {
  const r = [];

  // 1. lokale adapter in het robotsubnet?
  const subnet = ROBOT_IP.split(".").slice(0, 3).join(".");
  let eigenIP = null;
  for (const lijst of Object.values(os.networkInterfaces()))
    for (const a of lijst)
      if (a.family === "IPv4" && a.address.startsWith(subnet + ".")) eigenIP = a.address;
  r.push({ naam: `Eigen IP in ${subnet}.x`, ok: !!eigenIP,
           info: eigenIP || `geen adapter met ${subnet}.x gevonden — vast IP instellen` });

  // 2. ping naar de robot (systeemcommando, werkt op Windows en Linux)
  const pingCmd = process.platform === "win32"
    ? `ping -n 1 -w 1500 ${ROBOT_IP}` : `ping -c 1 -W 2 ${ROBOT_IP}`;
  const pingOk = await new Promise(res => exec(pingCmd, err => res(!err)));
  r.push({ naam: `Ping ${ROBOT_IP}`, ok: pingOk,
           info: pingOk ? "robot antwoordt" : "geen antwoord — kabel/IP controleren" });

  // 3. de drie robotpoorten
  r.push(await testPoort(RT_POORT,  `Poort ${RT_POORT} (uitlezen)`));
  r.push(await testPoort(CMD_POORT, `Poort ${CMD_POORT} (URScript)`));
  r.push(await testPoort(DASH_POORT,`Poort ${DASH_POORT} (dashboard)`));

  return r;
}

/* ------------------ Robot wisselen ------------------ */
function wisselRobot(ip) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    broadcast({ type: "error", message: "Ongeldig IP-adres: " + ip });
    return;
  }
  console.log(`[bridge] wissel naar robot ${ip}`);
  ROBOT_IP = ip;
  laatsteQ = null;
  if (rtSocket)  rtSocket.destroy();    // close-handlers verbinden opnieuw,
  if (dashSocket) dashSocket.destroy(); // nu met het nieuwe ROBOT_IP
  broadcast({ type: "status", robot: "wisselen naar " + ip });
}

/* ------------------ Berichten van de twin ------------------ */
wss.on("connection", ws => {
  console.log("[twin] verbonden");
  ws.on("message", data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "urscript" && typeof msg.script === "string") {
      stuurURScript(msg.script);
    }
    if (msg.type === "dashboard" && DASH_TOEGESTAAN.has(msg.cmd)) {
      stuurDashboard(msg.cmd);
    }
    if (msg.type === "freedrive") {
      stuurURScript(msg.aan ? FREEDRIVE_AAN : FREEDRIVE_UIT);
      console.log(`[robot] freedrive ${msg.aan ? "AAN" : "UIT"}`);
    }
    if (msg.type === "netcheck") {
      console.log("[bridge] netwerkcheck gestart …");
      netwerkCheck().then(res => {
        res.forEach(x => console.log(`[check] ${x.ok ? "OK  " : "FOUT"} ${x.naam}${x.info ? " — " + x.info : ""}`));
        ws.send(JSON.stringify({ type: "netcheck", robotIP: ROBOT_IP, resultaten: res }));
      });
    }
    if (msg.type === "setRobot" && typeof msg.ip === "string") {
      wisselRobot(msg.ip.trim());
    }
    if (msg.type === "programma" && Array.isArray(msg.stappen)) {
      console.log(`[programma] gestart (${msg.stappen.length} stappen)`);
      speelProgrammaAf(msg.stappen);
    }
    if (msg.type === "programmaStop") {
      programmaAfbreken = true;
      stuurDashboard("stop");
      console.log("[programma] stopcommando ontvangen");
    }
    if (msg.type === "grijperCommando" && typeof msg.open === "boolean") {
      stuurGrijperCommando(msg.open, msg.kracht)
        .then(() => wachtTotGrijperKlaar())
        .then(status => broadcast({ type: "grijperstatus", ...status, open: msg.open }))
        .catch(err => {
          console.log(`[grijper] fout: ${err.message}`);
          broadcast({ type: "error", message: "Grijper: " + err.message });
        });
    }
    if (msg.type === "grijperStatus") {
      leesGrijperStatus()
        .then(status => ws.send(JSON.stringify({ type: "grijperstatus", ...status })))
        .catch(err => ws.send(JSON.stringify({ type: "error", message: "Grijperstatus lezen mislukt: " + err.message })));
    }
  });
  ws.on("close", () => console.log("[twin] verbinding gesloten"));
});
