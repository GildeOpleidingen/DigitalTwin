' Start session-server.js stil op de achtergrond (geen zwart schermpje dat
' openblijft) en legt alle uitvoer vast in session-server.log, naast dit
' bestand — handig om achteraf te zien of hij wel/niet goed gestart is.
'
' AANPASSEN: zet het pad hieronder op de map waar session-server.js ECHT
' staat op deze (centrale) laptop.

Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = "C:\Users\testert\Documents\GitHub\DigitalTwin"
objShell.Run "cmd /c node session-server.js >> session-server.log 2>&1", 0, False
