/* ============================================================
   PLC BRIDGE — koppelt de webapp aan een Siemens S7-1200
   ============================================================
   Volledig losstaand van ur5-bridge.js: eigen proces, eigen
   WebSocket-poort, eigen configuratie. Je kunt ze naast elkaar
   draaien (twee "node ..."-vensters) zonder dat ze elkaar raken.

   Een browser kan niet rechtstreeks S7comm praten (het binaire
   protocol van Siemens, poort 102) — dit script doet dat wel, via
   de "nodes7"-library, en geeft de PLC-waarden door aan de webapp
   over WebSocket. Zelfde basisidee als de robot-bridge: lezen op
   een vaste frequentie, schrijven op commando.

   Bewust nodes7 gekozen i.p.v. Snap7/node-snap7 voor het gewone
   lezen/schrijven: nodes7 is pure JavaScript en heeft dus GEEN
   compiler/build-tools nodig bij de installatie (Snap7-wrappers
   wel, en dat is op een Windows-pc zonder Visual Studio een bekende
   hobbel). Voor STOP/RUN van de CPU (zie verderop) is dat niet te
   vermijden: dat is geen data-adres maar een apart S7-commando dat
   nodes7 niet aanbiedt, dus daarvoor wordt (optioneel) node-snap7
   gebruikt — met een geteste, door de snap7-makers geverifieerde
   implementatie, in plaats van dat ik dat protocol zelf naboots.

   INSTALLATIE (eenmalig, op de pc die aan de PLC hangt):
     1. Installeer Node.js (nodejs.org, LTS-versie).
     2. Open een terminal in deze map en voer uit:
          npm install ws nodes7
        Wil je ook STOP/RUN vanuit de webapp kunnen sturen, installeer
        dan ook:
          npm install node-snap7
        (Dit heeft soms wél een compiler nodig — lukt dat niet, dan
        blijft de rest van de bridge gewoon werken; alleen STOP/RUN
        geeft dan een duidelijke foutmelding i.p.v. de hele bridge
        te laten crashen.)
     3. Zet in TIA Portal, bij de CPU-eigenschappen → Bescherming:
        "PUT/GET-communicatie van externe partners toestaan" AAN.
        Zonder dit weigert de PLC elke verbinding van buitenaf.
     4. Voor elk datablok dat je hieronder wilt uitlezen/beschrijven:
        rechtsklik op het DB in TIA Portal → Eigenschappen →
        Attributen → "Optimized block access" UIT. Staat die AAN
        (de standaardinstelling), dan liggen de byte-adressen niet
        vast en kan deze bridge het geheugen niet terugvinden.

   PLC STOPPEN/STARTEN VANUIT DE WEBAPP
     Stuur over de WebSocket: { type: "plcCommando", commando: "stop" }
     of { type: "plcCommando", commando: "start", soort: "warm" }
     ("soort" is "warm" (standaard, HOT START) of "koud" (COLD START)).
     Elk commando opent een eigen, kortdurende snap7-verbinding naast
     de gewone nodes7-verbinding (en sluit 'm meteen weer) — dat kost
     een extra verbindingsslot op de PLC voor een fractie van een
     seconde, in plaats van er continu eentje bezet te houden.

   SIGNALEN CONFIGUREREN (verplicht, hieronder in dit bestand)
     Vul de SIGNALEN-lijst met je eigen adressen: een naam (zoals
     de webapp 'm aanspreekt), waar hij staat (DB/merker/ingang/
     uitgang + adres + evt. bit), het datatype, en of de webapp 'm
     mag beschrijven. Een paar voorbeelden staan als sjabloon in
     commentaar — kopieer en pas aan naar jouw PLC-programma.

   STARTEN
     Met parameter:    node plc-bridge.js 192.168.1.50
     Zonder parameter: node plc-bridge.js        (vraagt het IP op)
     Verbind je webapp daarna met ws://localhost:9190
     (poort aanpasbaar via de omgevingsvariabele WS_POORT).

   RACK / SLOT
     Standaard 0/1 — de gebruikelijke waarde voor een S7-1200.
     Alleen aanpassen (PLC_RACK / PLC_SLOT) als dit een ander
     CPU-type is.

   OP AFSTAND BEREIKBAAR MAKEN (wss:// direct vanuit dit script):
     Zet een certificaat en sleutel naast dit bestand als cert.pem
     en key.pem (of geef andere paden mee via TLS_CERT/TLS_KEY).
     Staan die er, dan start de bridge zelf al beveiligd op wss://;
     ontbreken ze, dan draait hij gewoon op onbeveiligd ws://
     (prima voor lokaal testen).

   NOG NIET GETEST TEGEN EEN ECHTE PLC — zie de meegeleverde
   testbestanden voor wat wél bevestigd is (de adresvertaling en
   de WebSocket-laag). Test dit met de echte S7-1200 voordat je
   'm op afstand ergens op vertrouwt, en meld het als iets niet
   klopt — dan passen we het samen aan.
   ============================================================ */

const fs = require("fs");
const https = require("https");
const readline = require("readline");
const WebSocket = require("ws");
const NodeS7 = require("nodes7");

/* STOP/RUN van de CPU: eerst node-snap7 (de geverifieerde C++-library) als die
   te laden is. Lukt dat niet — bijv. omdat er geen compiler is of geen admin-
   rechten, een veelvoorkomend probleem op Windows — dan valt de bridge terug
   op s7-besturing.js: dezelfde drie commando's in gewoon JavaScript, zonder
   installatie. Zo werkt STOP/RUN altijd, ook zonder node-snap7.            */
let Snap7 = null;
try { Snap7 = require("node-snap7"); }
catch (e) { console.log(`[plc/bridge] node-snap7 niet beschikbaar (${String(e.message).split("\n")[0]}) — STOP/RUN gebruikt de ingebouwde JavaScript-variant.`); }
let s7Besturing = null;
try { s7Besturing = require("./s7-besturing.js").s7Besturing; }
catch { /* s7-besturing.js ontbreekt naast dit bestand — dan blijft STOP/RUN afhankelijk van node-snap7 */ }

/* ------------------ Instellingen ------------------ */
const WS_POORT = +(process.env.WS_POORT || 9190);   // bewust een andere reeks dan de robot-bridge (9090+), zodat ze nooit kunnen botsen
const RACK = +(process.env.PLC_RACK ?? 0);
const SLOT = +(process.env.PLC_SLOT ?? 1);
const POLL_HZ = +(process.env.POLL_HZ || 10);        // hoe vaak we de PLC uitlezen en naar de webapp sturen
const TLS_CERT = process.env.TLS_CERT || "cert.pem";
const TLS_KEY = process.env.TLS_KEY || "key.pem";

/* ------------------ Signalen: PAS DIT AAN NAAR JOUW PLC-PROGRAMMA ------------------
   gebied:      "db" | "merker" | "ingang" | "uitgang"
   db:          alleen nodig bij gebied "db" — het datablocknummer (DB1 -> 1)
   adres:       bytenummer binnen dat gebied/db
   bit:         alleen bij type "bool" — welk bitje in dat byte (0-7)
   type:        "bool" | "byte" | "int" (16-bit) | "dint" (32-bit) | "real" (32-bit float)
   schrijfbaar: mag de webapp dit signaal beschrijven? (standaard: alleen lezen)        */
/* ---- Hulpfuncties om snel een rij signalen te maken ---- */
function digitaleIngangen(groep, startByte, aantal, naamVoor) {
  // aantal bits vanaf byte "startByte", bit 0; alleen lezen (een ingang kun je vanaf hier niet "indrukken")
  return Array.from({ length: aantal }, (_, i) => ({
    groep, naam: `${naamVoor}${startByte + Math.floor(i / 8)}.${i % 8}`, gebied: "ingang",
    adres: startByte + Math.floor(i / 8), bit: i % 8, type: "bool", schrijfbaar: false,
  }));
}
function digitaleUitgangen(groep, startByte, aantal, naamVoor) {
  return Array.from({ length: aantal }, (_, i) => ({
    groep, naam: `${naamVoor}${startByte + Math.floor(i / 8)}.${i % 8}`, gebied: "uitgang",
    adres: startByte + Math.floor(i / 8), bit: i % 8, type: "bool", schrijfbaar: true,
  }));
}

/* ---- CPU 1215C DC/DC/DC (6ES7 215-1AG40-0XB0): vaste, ingebouwde adressen ---- */
const ONBOARD = [
  ...digitaleIngangen("CPU ingangen (DI a/b)", 0, 14, "I"),            // I0.0-I0.7 en I1.0-I1.5
  ...digitaleUitgangen("CPU uitgangen (DQ a/b)", 0, 10, "Q"),          // Q0.0-Q0.7 en Q1.0-Q1.1
  { groep: "CPU analoog", naam: "AI0 (IW64)", gebied: "ingang", adres: 64, type: "int", schrijfbaar: false },  // 0-10 V = 0..27648
  { groep: "CPU analoog", naam: "AI1 (IW66)", gebied: "ingang", adres: 66, type: "int", schrijfbaar: false },
  { groep: "CPU analoog", naam: "AQ0 (QW80)", gebied: "uitgang", adres: 80, type: "int", schrijfbaar: true },  // 0-20 mA = 0..27648
  { groep: "CPU analoog", naam: "AQ1 (QW82)", gebied: "uitgang", adres: 82, type: "int", schrijfbaar: true },
];

/* ---- Uitbreidingsmodules: de adressen stel je in TIA Portal in (Device view -> module ->
   Properties -> I/O addresses). Controleer ze en pas ze hier aan. "null" = module niet gebruikt. ---- */
const DC_RLY = {          // SM 1223 DI/DQ DC/RLY — aantal kanalen: 8 of 16
  beginIngangByte: 2,     // eerste ingangsbyte (I2.0 = 2)   <-- CONTROLEER IN TIA
  beginUitgangByte: 2,    // eerste uitgangsbyte (Q2.0 = 2)  <-- CONTROLEER IN TIA
  aantalIngangen: 8,
  aantalUitgangen: 8,
};
const IO_LINK = {         // SM 1278 4xIO-Link master
  beginIngangByte: null,  // eerste ingangsbyte van poort 1, bv. 8   <-- INVULLEN UIT TIA
  beginUitgangByte: null, // eerste uitgangsbyte van poort 1, bv. 8  <-- INVULLEN UIT TIA
  bytesInPerPoort: 2,     // procesdata-lengte ingang per poort (zoals in TIA ingesteld)
  bytesUitPerPoort: 2,    // procesdata-lengte uitgang per poort
};

const MODULESIGNALEN = [];
if (DC_RLY) {
  MODULESIGNALEN.push(...digitaleIngangen("DC/RLY-module ingangen", DC_RLY.beginIngangByte, DC_RLY.aantalIngangen, "I"));
  MODULESIGNALEN.push(...digitaleUitgangen("DC/RLY-module uitgangen (relais)", DC_RLY.beginUitgangByte, DC_RLY.aantalUitgangen, "Q"));
}
if (IO_LINK && IO_LINK.beginIngangByte !== null) {
  for (let poort = 0; poort < 4; poort++) {
    // Procesdata is vaak een 16-bit getal (big-endian, zo leest de PLC het): dan telt "int" als één waarde.
    for (let w = 0; w < Math.floor(IO_LINK.bytesInPerPoort / 2); w++)
      MODULESIGNALEN.push({ groep: "IO-Link ingangen", naam: `IOL poort ${poort + 1} in${w}`, gebied: "ingang",
        adres: IO_LINK.beginIngangByte + poort * IO_LINK.bytesInPerPoort + w * 2, type: "int", schrijfbaar: false });
    if (IO_LINK.bytesInPerPoort % 2 === 1)
      MODULESIGNALEN.push({ groep: "IO-Link ingangen", naam: `IOL poort ${poort + 1} byte`, gebied: "ingang",
        adres: IO_LINK.beginIngangByte + poort * IO_LINK.bytesInPerPoort + IO_LINK.bytesInPerPoort - 1, type: "byte", schrijfbaar: false });
  }
}
if (IO_LINK && IO_LINK.beginUitgangByte !== null) {
  for (let poort = 0; poort < 4; poort++)
    for (let w = 0; w < Math.floor(IO_LINK.bytesUitPerPoort / 2); w++)
      MODULESIGNALEN.push({ groep: "IO-Link uitgangen", naam: `IOL poort ${poort + 1} uit${w}`, gebied: "uitgang",
        adres: IO_LINK.beginUitgangByte + poort * IO_LINK.bytesUitPerPoort + w * 2, type: "int", schrijfbaar: true });
}
if (IO_LINK && IO_LINK.beginIngangByte === null)
  console.log("[plc/bridge] IO-Link-master staat nog uit: vul IO_LINK.beginIngangByte/beginUitgangByte in plc-bridge.js in (adressen uit TIA Portal).");

const SIGNALEN = [
  ...ONBOARD,
  ...MODULESIGNALEN,

  // Eigen signalen uit een DB kun je hieronder toevoegen (zie de voorbeelden):
  // { groep: "Programma", naam: "motorVrijgave",    gebied: "db", db: 1, adres: 0, bit: 1, type: "bool", schrijfbaar: true },
  // { groep: "Programma", naam: "setpointSnelheid", gebied: "db", db: 1, adres: 2, type: "int", schrijfbaar: true },
  // { groep: "Programma", naam: "gemetenPositie",   gebied: "db", db: 1, adres: 4, type: "real", schrijfbaar: false },
];

if (SIGNALEN.length === 0) {
  console.log("[plc/bridge] Let op: de SIGNALEN-lijst in plc-bridge.js is nog leeg.");
  console.log("[plc/bridge] Open dit bestand en vul 'm met je eigen DB/merker-adressen (zie de voorbeelden in commentaar).");
}

/* ------------------ Adresvertaling: onze eigen (Nederlandse) configuratie
   -> het adresformaat dat nodes7 verwacht (zie stringToS7Addr() in
   node_modules/nodes7/nodeS7.js voor de exacte lijst die het accepteert).
   nodes7-syntax, kort samengevat:
     bit (merker/ingang/uitgang): kale gebiedsletter, GEEN typeletter
                                  bijv. "M0.0", "I0.0", "Q1.3"
     bit (DB):                   wél een typeletter ("X")
                                  bijv. "DB1,X2.3"
     byte:  "<gebied><B><byte>"  bijv. "MB0",  "IB2",  "DB1,B2"
     int16: "<gebied><I><byte>"  bijv. "MI0",  "II2",  "DB1,I2"
     dint:  "<gebied><DI><byte>" bijv. "MDI0", "IDI2", "DB1,DI2"
     real:  "<gebied><R><byte>"  bijv. "MR0",  "IR2",  "DB1,R2"
   Let op: dit is de belangrijkste plek om fout te gaan — een "MX0.0"
   (met X) lijkt logisch maar bestaat niet in nodes7's adresformaat en
   levert een stille "geen match"-fout op in plaats van data. Vandaar
   test-plc-adressen.js, die dit expliciet tegen alle gebieden/types
   controleert.                                                             */
function nodes7Adres(sig) {
  const isDb = sig.gebied === "db";
  const voorvoegsel = isDb ? `DB${sig.db},` : "";
  const gebiedLetter = { merker: "M", ingang: "I", uitgang: "Q" }[sig.gebied] || "";

  if (sig.type === "bool") {
    return isDb
      ? `${voorvoegsel}X${sig.adres}.${sig.bit ?? 0}`
      : `${gebiedLetter}${sig.adres}.${sig.bit ?? 0}`;
  }
  const typeLetter = { byte: "B", int: "I", dint: "DI", real: "R" }[sig.type];
  return `${voorvoegsel}${isDb ? "" : gebiedLetter}${typeLetter}${sig.adres}`;
}

const nodes7AdresPerNaam = {};
SIGNALEN.forEach(sig => { nodes7AdresPerNaam[sig.naam] = nodes7Adres(sig); });

const conn = new NodeS7();
conn.setTranslationCB(naam => nodes7AdresPerNaam[naam]);
if (SIGNALEN.length > 0) conn.addItems(SIGNALEN.map(s => s.naam));

let plcIp = null;

/* ------------------ WebSocket-server ------------------ */
let wss;
const heeftCertificaat = fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY);
if (heeftCertificaat) {
  const httpsServer = https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  });
  wss = new WebSocket.Server({ server: httpsServer });
  httpsServer.listen(WS_POORT, () => {
    console.log(`[plc/bridge] beveiligde WebSocket-server actief op wss://<dit-adres>:${WS_POORT}`);
  });
  httpsServer.on("error", err => console.log(`[plc/bridge] kon niet starten op poort ${WS_POORT}: ${err.message}`));
} else {
  wss = new WebSocket.Server({ port: WS_POORT });
  console.log(`[plc/bridge] WebSocket-server actief op ws://localhost:${WS_POORT}`);
  console.log(`[plc/bridge] (onbeveiligd — leg ${TLS_CERT} en ${TLS_KEY} naast dit bestand voor wss://)`);
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(data); });
}

/* ------------------ Verbinden met de PLC ------------------
   Alleen deze EERSTE verbindingspoging moet zelf opnieuw geprobeerd worden
   bij een fout — zodra er ooit een verbinding tot stand is gekomen, herstelt
   nodes7 een latere onderbreking (kabel eruit, PLC herstart, …) zelf, met
   een eigen interne reconnect-timer. Wij hoeven daar niets voor te doen; we
   lezen bij elke poll gewoon de actuele verbindingsstatus uit (_COMMERR).  */
function verbindEersteKeer() {
  conn.initiateConnection({ port: 102, host: plcIp, rack: RACK, slot: SLOT }, err => {
    if (err) {
      console.log(`[plc/verbinding] verbinden mislukt: ${(err && err.message) || err} — nieuwe poging over 3 s`);
      broadcast({ type: "status", plc: "verbroken" });
      setTimeout(verbindEersteKeer, 3000);
      return;
    }
    console.log(`[plc/verbinding] verbonden met ${plcIp} (rack ${RACK}, slot ${SLOT})`);
    broadcast({ type: "status", plc: "verbonden" });
  });
}

function isVerbonden() {
  // _COMMERR is een ingebouwd pseudo-adres van nodes7: value = true betekent
  // NIET verbonden (isoConnectionState !== 4), dus we keren het om.
  const status = conn.findItem("_COMMERR");
  return !!status && status.value === false;
}

let vorigeVerbindingsStatus = null;

/* Periodiek uitlezen, net als de joints/IO-broadcast in de robot-bridge.
   Altijd een bericht sturen (ook zonder verbinding of zonder signalen) met
   een expliciete 'verbonden'-vlag, zodat de webapp nooit gewoon stil blijft
   zonder dat duidelijk is of dat een kapotte bridge is of gewoon geen data.  */
setInterval(() => {
  const verbonden = isVerbonden();
  if (verbonden !== vorigeVerbindingsStatus) {
    console.log(`[plc/verbinding] ${verbonden ? "verbonden" : "niet verbonden (nodes7 probeert zelf opnieuw)"}`);
    broadcast({ type: "status", plc: verbonden ? "verbonden" : "verbroken" });
    vorigeVerbindingsStatus = verbonden;
  }

  if (!verbonden || SIGNALEN.length === 0) {
    broadcast({ type: "plcData", verbonden: verbonden && SIGNALEN.length > 0, plcVerbonden: verbonden, signalen: {} });
    return;
  }
  conn.readAllItems((eenOfMeerFout, waarden) => {
    if (eenOfMeerFout) {
      console.log("[plc/io] één of meer signalen gaven een foutkwaliteit terug bij het lezen — zie de waarden hieronder");
    }
    broadcast({ type: "plcData", verbonden: true, plcVerbonden: true, signalen: waarden });
  });
}, 1000 / POLL_HZ);

/* ------------------ Schrijven vanuit de webapp ------------------ */
function schrijfSignaal(naam, waarde, klaar) {
  const sig = SIGNALEN.find(s => s.naam === naam);
  if (!sig) return klaar(new Error(`onbekend signaal: ${naam}`));
  if (!sig.schrijfbaar) return klaar(new Error(`signaal "${naam}" is niet schrijfbaar (schrijfbaar: false in de configuratie)`));
  if (!isVerbonden()) return klaar(new Error("PLC niet verbonden"));
  conn.writeItems(naam, waarde, eenOfMeerFout => {
    if (eenOfMeerFout) return klaar(new Error("de PLC wees het schrijfcommando af (controleer adres, type en 'Optimized block access')"));
    klaar(null);
  });
}

/* ------------------ CPU stoppen/starten (node-snap7, optioneel) ------------------
   Los van de gewone nodes7-verbinding: opent een eigen, kortdurende
   snap7-verbinding, voert precies één commando uit, en sluit 'm meteen
   weer — in plaats van continu een tweede verbinding naar de PLC open
   te houden alleen voor het geval dat er ooit een stop/start komt.    */
function metSnap7Verbinding(uitvoeren, klaar) {
  if (!Snap7) return klaar(new Error('node-snap7 is niet geïnstalleerd — "npm install node-snap7" nodig voor STOP/RUN (zie de installatie-instructies bovenin dit bestand)'));
  const client = new Snap7.S7Client();
  client.ConnectTo(plcIp, RACK, SLOT, err => {
    if (err) return klaar(new Error("kon niet verbinden voor het STOP/RUN-commando: " + client.ErrorText(err)));
    uitvoeren(client, fout => { client.Disconnect(); klaar(fout); });
  });
}

function plcStop(klaar) {
  if (!Snap7) return zonderSnap7("stop", "warm", klaar);
  metSnap7Verbinding((client, terug) => {
    client.PlcStop(err => terug(err ? new Error(client.ErrorText(err)) : null));
  }, klaar);
}

function plcStart(soort, klaar) {
  if (!Snap7) return zonderSnap7("start", soort, klaar);
  metSnap7Verbinding((client, terug) => {
    const start = soort === "koud" ? client.PlcColdStart : client.PlcHotStart;
    start.call(client, err => terug(err ? new Error(client.ErrorText(err)) : null));
  }, klaar);
}

function zonderSnap7(commando, soort, klaar) {
  if (!s7Besturing) return klaar(new Error('STOP/RUN niet beschikbaar: zet s7-besturing.js naast plc-bridge.js, of installeer node-snap7 ("npm install node-snap7")'));
  s7Besturing({ ip: plcIp, rack: RACK, slot: SLOT, commando, soort }, klaar);
}

/* ------------------ Berichten van de webapp ------------------ */
wss.on("connection", ws => {
  console.log("[plc/webapp] verbonden");
  // Meteen de signaallijst meesturen, zodat de webapp zelf bedieningselementen
  // kan opbouwen (schakelaar voor bool, invoerveld voor getallen) en weet
  // welke signalen schrijfbaar zijn — zonder dat jij ze daar nog eens moet invullen.
  // Huidige PLC-status ook meteen aan deze nieuwe webapp melden: de status-broadcast
  // hierboven gaat alleen bij een VERANDERING uit, dus wie later verbindt zou anders
  // eeuwig op "wacht op de PLC" blijven staan.
  ws.send(JSON.stringify({ type: "status", plc: isVerbonden() ? "verbonden" : "verbroken" }));
  ws.send(JSON.stringify({
    type: "signalen",
    lijst: SIGNALEN.map(s => ({ naam: s.naam, type: s.type, gebied: s.gebied, groep: s.groep || "", adres: s.adres, bit: s.bit, db: s.db, schrijfbaar: !!s.schrijfbaar })),
  }));
  ws.on("message", data => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === "schrijf" && typeof msg.naam === "string") {
      schrijfSignaal(msg.naam, msg.waarde, err => {
        if (err) {
          console.log(`[plc/io] schrijven van "${msg.naam}" mislukt: ${err.message}`);
          ws.send(JSON.stringify({ type: "error", message: `Schrijven van "${msg.naam}" mislukt: ${err.message}` }));
        } else {
          console.log(`[plc/io] geschreven: ${msg.naam} = ${msg.waarde}`);
        }
      });
    }
    if (msg.type === "plcCommando" && (msg.commando === "stop" || msg.commando === "start")) {
      const klaar = err => {
        if (err) {
          console.log(`[plc/besturing] ${msg.commando} mislukt: ${err.message}`);
          ws.send(JSON.stringify({ type: "error", message: `PLC ${msg.commando === "stop" ? "stoppen" : "starten"} mislukt: ${err.message}` }));
        } else {
          console.log(`[plc/besturing] CPU ${msg.commando === "stop" ? "gestopt" : "gestart (" + (msg.soort === "koud" ? "koude" : "warme") + " start)"}`);
          broadcast({ type: "plcBesturing", commando: msg.commando, soort: msg.soort || "warm", gelukt: true });
        }
      };
      if (msg.commando === "stop") plcStop(klaar);
      else plcStart(msg.soort === "koud" ? "koud" : "warm", klaar);
    }
  });
  ws.on("close", () => console.log("[plc/webapp] verbinding gesloten"));
});

/* ------------------ IP-adres bepalen: via parameter, of anders interactief ------------------ */
function vraagIPInteractief() {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("PLC IP-adres: ", antwoord => { rl.close(); resolve(antwoord.trim()); });
  });
}

async function bepaalPlcIp() {
  const argIp = (process.argv[2] || "").trim();
  if (argIp) return argIp;
  console.log("Geen IP-adres meegegeven bij het starten.");
  let ip = await vraagIPInteractief();
  while (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    console.log(`"${ip}" ziet er niet uit als een IP-adres (bijv. 192.168.1.50) — probeer opnieuw.`);
    ip = await vraagIPInteractief();
  }
  return ip;
}

(async () => {
  plcIp = await bepaalPlcIp();
  console.log(`\n[plc/bridge] start met PLC ${plcIp} — WebSocket op poort ${WS_POORT}\n`);
  verbindEersteKeer();
})();