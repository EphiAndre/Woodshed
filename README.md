# Woodshed

App desktop per Mac e Windows che separa un brano in sei tracce (chitarra, basso, batteria, voce, piano, altro) per studiare lo strumento: mixer con mute e solo, velocità e tonalità indipendenti in tempo reale, loop A-B, metronomo agganciato ai battiti del brano con BPM rilevato, esportazione WAV per la DAW ed eliminazione dei brani per liberare spazio.

## Ottenere l'app senza installare Python (consigliato)

Python serve solo per costruire l'app: quella finita lo contiene già, quindi chi la usa non deve installare nulla. La costruzione la fanno gratis i computer Mac e Windows di GitHub.

1. Crea un account su github.com, poi un nuovo repository (pulsante "New"). Puoi sceglierlo privato o pubblico, vedi la nota sui minuti più sotto.
2. Nella pagina del repository scegli "uploading an existing file" e trascina tutti i file e le cartelle del progetto, poi premi "Commit changes".
3. La cartella `.github` non sempre viene caricata trascinando, perché su Mac i nomi che iniziano con un punto sono nascosti. Per sicurezza creala a mano: "Add file", poi "Create new file", come nome scrivi `.github/workflows/build.yml` e incolla il contenuto del file `build.yml` che trovi nel progetto, in `.github/workflows`. Nel Finder quella cartella è nascosta: premi Cmd+Maiusc+punto per mostrarla. Premi "Commit changes".
4. Apri la scheda "Actions": la costruzione parte da sola e dura circa 15-25 minuti. Se non parte, scegli "Costruisci Woodshed" a sinistra e poi "Run workflow".
5. A costruzione finita (spunta verde) apri l'esecuzione e scarica dalla sezione "Artifacts" la versione che ti serve: `Woodshed-Mac-AppleSilicon` (Mac con chip M1, M2, M3, M4…), `Woodshed-Mac-Intel` o `Woodshed-Windows`. Ogni file è uno zip che contiene un altro zip: estraili entrambi.

Ogni volta che carichi una versione nuova dei file, GitHub ricostruisce tutto da solo. Le app restano scaricabili per 30 giorni.

Nota sui minuti: con un repository pubblico le costruzioni sono gratuite senza limiti. Con uno privato c'è una quota mensile gratuita e i Mac ne consumano molto di più di Windows, quindi conviene ricostruire solo quando serve.

Le sezioni 1, 2 e 3 qui sotto servono solo se preferisci costruire l'app sul tuo computer.

## 1. Preparazione (una volta sola)

Serve **Python 3.11 o 3.12** (da python.org). Apri il Terminale (Mac) o il Prompt dei comandi (Windows) nella cartella del progetto.

Mac:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

Windows:

```bat
py -3.11 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Su Windows PyTorch da PyPI è già la versione solo CPU, la più leggera. Se hai una scheda NVIDIA e vuoi separazioni più rapide, dopo il comando sopra installa la versione CUDA seguendo le istruzioni su pytorch.org (il pacchetto finale diventa però molto più pesante).

## 2. Provarla

```bash
python app.py
```

Al primo brano l'app scarica il modello di separazione (circa 50 MB), quindi serve la connessione. Dalla volta successiva funziona offline.

## 3. Creare l'app installabile

Va fatto su ciascun sistema: il pacchetto per Mac si crea su un Mac, quello per Windows su Windows.

- Mac: `./build_mac.sh` produce `dist/Woodshed.app`
- Windows: `build_windows.bat` produce la cartella `dist\Woodshed\` con dentro `Woodshed.exe`

## Primo avvio

- Mac: l'app non è firmata da Apple, quindi al primo avvio macOS la blocca. Chiudi l'avviso, apri Impostazioni di Sistema, poi Privacy e sicurezza, scorri in basso e premi "Apri comunque" accanto a Woodshed. Serve solo la prima volta. Se invece compare il messaggio che l'app è danneggiata, apri il Terminale e scrivi `xattr -cr ` seguito dal percorso dell'app (puoi trascinarla nella finestra), poi premi Invio e riaprila.
- Windows: tieni insieme tutta la cartella `Woodshed` e avvia `Woodshed.exe`. Se compare SmartScreen, scegli "Ulteriori informazioni" e poi "Esegui comunque".

## Metronomo

Dopo la separazione l'app rileva la posizione di ogni battito del brano, quindi il click segue il tempo reale anche nei brani registrati senza click, dove il tempo accelera o rallenta. Il BPM mostrato è quello alla velocità attuale. Se l'accento sul primo tempo cade sul battito sbagliato, "Sposta accento" lo porta al successivo. I pulsanti − e + anticipano o ritardano il click di 10 ms. Le correzioni restano salvate per quel brano. Per i brani separati prima di questa versione, il tempo viene rilevato alla prima apertura, in pochi secondi.

## Dove finiscono i file

- Libreria dei brani separati (FLAC 24 bit) e modello:
  Mac `~/Library/Application Support/Woodshed`, Windows `%APPDATA%\Woodshed`
- Le esportazioni vanno nella cartella che scegli, in una sottocartella "Titolo - tracce" con un WAV per strumento, tutti allineati dall'inizio. Con l'opzione "Includi il click" c'è anche "Titolo - Click.wav": stessa durata, a tempo con il brano, con l'accento e le correzioni salvate per quel brano.

## Struttura del progetto

- `app.py`: avvio, finestra desktop, server locale e comandi richiamati dall'interfaccia
- `separator.py`: lettura audio con ffmpeg (incluso) e separazione con Demucs
- `beats.py`: rilevamento di battiti, BPM e primo tempo della battuta (solo NumPy, nessuna libreria pesante)
- `library.py`: coda di separazione, spazio su disco, battiti, esportazione ed eliminazione
- `gui/`: interfaccia (HTML e JavaScript), con SoundTouch per velocità e tonalità
- `Woodshed.spec`: configurazione di PyInstaller
- `.github/workflows/build.yml`: costruzione automatica su GitHub per Mac e Windows

## Licenze dei componenti

Demucs (Meta) è MIT. SoundTouch JS è LGPL 2.1 ed è incluso senza modifiche in `gui/vendor`. Per uso personale non ci sono vincoli particolari; se un giorno volessi distribuirla, conviene ricontrollarle.
