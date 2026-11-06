# Cash Fresh

App per la spesa: conta i prezzi mentre fai la spesa e ti dice quanti buoni pasto usare e quanto pagare a parte.

## Come si usa

- **Spesa**: scrivi il prezzo (o scansiona il codice a barre) e premi Aggiungi. In alto vedi il totale, quanti buoni usare e quanto pagare in contanti o carta. Il riquadro diventa arancione vicino al limite e rosso quando lo superi.
- **Prodotti** (database prodotti): ogni prodotto inserito con un nome o un codice a barre viene salvato con il suo prezzo. Quando scansioni un codice nuovo, nome, marca e foto arrivano da [Open Food Facts](https://world.openfoodfacts.org) (gratuito, senza account); il prezzo lo scrivi tu una volta. Nella scheda Prodotti puoi cercare, modificare nome/marca/prezzo, vedere lo storico dei prezzi ed eliminare.
- **Prezzi che cambiano**: tocca il prezzo di un prodotto nello scontrino virtuale (o il messaggio verde che appare dopo la scansione) per correggerlo. Il nuovo prezzo diventa quello ricordato e il vecchio resta nello storico.
- **Backup**: in Opzioni puoi esportare il database prodotti in un file JSON e reimportarlo (per esempio su un altro telefono). La ricerca online si può disattivare.
- **Concludi spesa**: salva lo scontrino nello storico e scala i buoni usati dal saldo.
- **Impostazioni**: valore del buono (predefinito 11 €), massimo buoni per scontrino (predefinito 8), buoni rimasti e buoni mensili.

I dati restano solo sul telefono (localStorage). Nessun server.

## Installare su iPhone

Apri il sito in Safari → Condividi → "Aggiungi alla schermata Home".

## Tecnica

HTML, CSS e JavaScript senza build. Il lettore di codici a barre usa `BarcodeDetector` dove esiste e altrimenti [ZXing](https://github.com/zxing-js/library) (MIT), incluso in `vendor/`. Un service worker rende l'app utilizzabile offline.
