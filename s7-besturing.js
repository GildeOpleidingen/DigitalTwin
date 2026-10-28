/* ============================================================
   S7-BESTURING — CPU stoppen/starten zonder node-snap7
   ============================================================
   node-snap7 is een C++-library die bij installatie soms gecompileerd
   moet worden (Visual Studio / Python nodig). Op een pc zonder
   compiler of zonder admin-rechten lukt dat niet — dan was STOP/RUN
   niet beschikbaar. Dit bestand doet precies dat ene ding (CPU stop,
   warme start, koude start) in gewoon JavaScript, zonder iets te
   installeren: het praat zelf het S7-protocol (poort 102) met de PLC.

   Het is een kleine, vaste reeks van drie berichten (verbinding opzetten,
   communicatie afspreken, commando sturen). De bytes zijn vergeleken met
   wat de echte snap7-client stuurt (zie test-s7-besturing.js).
   NOG NIET GETEST TEGEN EEN ECHTE CPU.
   ============================================================ */
const net = require("net");

const P_PROGRAM = Buffer.from("P_PROGRAM", "ascii");

function verbindingsverzoek(rack, slot) {
  // COTP Connection Request: lokale TSAP 01.00, externe TSAP 01.(rack*32+slot)
  return Buffer.from([
    0x03, 0x00, 0x00, 0x16, 0x11, 0xe0, 0x00, 0x00, 0x00, 0x01, 0x00,
    0xc0, 0x01, 0x0a,
    0xc1, 0x02, 0x01, 0x00,
    0xc2, 0x02, 0x01, (rack * 0x20 + slot) & 0xff,
  ]);
}

const SETUP_COMMUNICATIE = Buffer.from([
  0x03, 0x00, 0x00, 0x19, 0x02, 0xf0, 0x80,
  0x32, 0x01, 0x00, 0x00, 0x04, 0x00, 0x00, 0x08, 0x00, 0x00,
  0xf0, 0x00, 0x00, 0x01, 0x00, 0x01, 0x01, 0xe0,   // PDU-lengte 480
]);

function pdu(commando, soort) {
  let parameters, pduRef;
  if (commando === "stop") {
    pduRef = [0x0e, 0x00];
    parameters = Buffer.concat([Buffer.from([0x29, 0x00, 0x00, 0x00, 0x00, 0x00, 0x09]), P_PROGRAM]);
  } else if (soort === "koud") {
    pduRef = [0x0f, 0x00];
    parameters = Buffer.concat([Buffer.from([0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd, 0x00, 0x02, 0x43, 0x20, 0x09]), P_PROGRAM]);
  } else {
    pduRef = [0x0c, 0x00];
    parameters = Buffer.concat([Buffer.from([0x28, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xfd, 0x00, 0x00, 0x09]), P_PROGRAM]);
  }
  const s7Kop = Buffer.from([0x32, 0x01, 0x00, 0x00, pduRef[0], pduRef[1], 0x00, parameters.length, 0x00, 0x00]);
  const totaal = 4 + 3 + s7Kop.length + parameters.length;
  return Buffer.concat([Buffer.from([0x03, 0x00, 0x00, totaal, 0x02, 0xf0, 0x80]), s7Kop, parameters]);
}

/* commando: "stop" | "start";  soort: "warm" | "koud" (alleen bij start) */
function s7Besturing({ ip, rack = 0, slot = 1, commando, soort = "warm", poort = 102, timeoutMs = 5000 }, klaar) {
  let afgerond = false;
  const socket = net.connect({ host: ip, port: poort });
  const einde = fout => {
    if (afgerond) return;
    afgerond = true;
    clearTimeout(timer);
    socket.destroy();
    klaar(fout || null);
  };
  const timer = setTimeout(() => einde(new Error("geen antwoord van de PLC (time-out)")), timeoutMs);

  let stap = 0;        // 0: wacht op CC, 1: wacht op setup-antwoord, 2: wacht op commando-antwoord
  let buf = Buffer.alloc(0);
  socket.on("error", err => einde(new Error("netwerkfout naar de PLC: " + err.message)));
  socket.on("close", () => einde(new Error("de PLC sloot de verbinding voor het commando klaar was")));
  socket.on("connect", () => socket.write(verbindingsverzoek(rack, slot)));
  socket.on("data", data => {
    buf = Buffer.concat([buf, data]);
    while (buf.length >= 4) {
      const len = buf.readUInt16BE(2);
      if (buf.length < len) return;
      const frame = buf.subarray(0, len);
      buf = buf.subarray(len);
      if (stap === 0) {
        if (frame[5] !== 0xd0) return einde(new Error("de PLC weigerde de verbinding (controleer rack/slot en PUT/GET)"));
        stap = 1; socket.write(SETUP_COMMUNICATIE);
      } else if (stap === 1) {
        if (frame[7] !== 0x32 || frame[8] !== 0x03 || frame[17] !== 0 || frame[18] !== 0)
          return einde(new Error("de PLC weigerde het afspreken van de communicatie"));
        stap = 2; socket.write(pdu(commando, soort));
      } else {
        const hex = frame.toString("hex").replace(/(..)/g, "$1 ").trim();
        // Geen S7-datapakket (bv. COTP-verbreking): de PLC beëindigt de sessie
        if (frame[5] !== 0xf0 || frame[7] !== 0x32)
          return einde(new Error(`de PLC antwoordde met een ander pakket dan verwacht (bytes: ${hex}) — meestal beveiliging of "PUT/GET" die niet echt in de CPU is gedownload`));
        const soortBericht = frame[8];
        // 0x02 = Ack, 0x03 = Ack_Data: beide hebben foutklasse/-code op byte 17/18
        if (soortBericht === 0x02 || soortBericht === 0x03) {
          const klasse = frame[17], code = frame[18];
          if (klasse === 0x81 && code === 0x04)
            return einde(new Error("deze CPU ondersteunt STOP/START niet via het netwerk (S7-1200/1500 laten via PUT/GET alleen data lezen en schrijven toe). Gebruik de STOP-instructie in het PLC-programma, de webserver van de CPU, of TIA Portal."));
          if (klasse !== 0 || code !== 0)
            return einde(new Error(`de PLC wees het commando af (S7-foutklasse 0x${klasse.toString(16)}, code 0x${code.toString(16)}; bytes: ${hex})`));
          return einde(null);
        }
        return einde(new Error(`onverwacht antwoord van de PLC (berichtsoort 0x${soortBericht.toString(16)}; bytes: ${hex})`));
      }
    }
  });
}

module.exports = { s7Besturing, _bytes: { verbindingsverzoek, SETUP_COMMUNICATIE, pdu } };