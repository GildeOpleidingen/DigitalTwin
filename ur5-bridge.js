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
          npm install ws
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
   ============================================================ */

const net = require("net");
const WebSocket = require("ws");

/* ------------------ INSTELLINGEN ------------------ */
let ROBOT_IP = process.argv[2] || "192.168.1.100";   // IP van de robot
/* Ander IP? Start met:  node ur5-bridge.js 192.168.192.4
   of wissel tijdens gebruik via de twin (knop "Wissel robot"). */
const RT_POORT   = 30003;            // realtime interface (uitlezen, 125 Hz)
const CMD_POORT  = 30002;            // secondary interface (URScript sturen)
const WS_POORT   = 9090;             // poort waarop de twin verbindt
const ZEND_HZ    = 15;               // hoe vaak joints naar de twin gaan
/* --------------------------------------------------- */

/* WebSocket-server voor de twin(s) */
const wss = new WebSocket.Server({ port: WS_POORT });
console.log(`[bridge] WebSocket-server actief op ws://localhost:${WS_POORT}`);
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

async function wachtTotRobotKlaar(timeoutMs = 30000) {
  await new Promise(r => setTimeout(r, 350));      // even ruimte om de vorige start te laten inzetten
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (programmaAfbreken) throw new Error("afgebroken door gebruiker");
    const antwoord = await dashboardVraag("running");
    if (/false/i.test(antwoord)) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("time-out: robot bleef bezig");
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
        const laadAntwoord = await dashboardVraag("load " + stap.programma);
        if (/error|kan niet|not found|file not found/i.test(laadAntwoord))
          throw new Error("laden mislukt (" + laadAntwoord + ") — bestaat " + stap.programma + " in /programs?");
        await dashboardVraag("play");
        await wachtTotRobotKlaar();
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
  });
  ws.on("close", () => console.log("[twin] verbinding gesloten"));
});