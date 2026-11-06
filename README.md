# Cash Fresh

App per la spesa: conta i prezzi mentre fai la spesa e ti dice quanti buoni pasto usare e quanto pagare a parte.

## Come si usa

- **Spesa**: scrivi il prezzo (o scansiona il codice a barre) e premi Aggiungi. In alto vedi il totale, quanti buoni usare e quanto pagare in contanti o carta. Il riquadro diventa arancione vicino al limite e rosso quando lo superi.
- **Prodotti salvati**: ogni prezzo inserito con un nome o un codice a barre viene ricordato. La prossima volta basta scansionarlo o toccarlo in "Aggiungi di nuovo".
- **Concludi spesa**: salva lo scontrino nello storico e scala i buoni usati dal saldo.
- **Impostazioni**: valore del buono (predefinito 11 €), massimo buoni per scontrino (predefinito 8), buoni rimasti e buoni mensili.

I dati restano solo sul telefono (localStorage). Nessun server.

## Installare su iPhone

Apri il sito in Safari → Condividi → "Aggiungi alla schermata Home".

## Tecnica

HTML, CSS e JavaScript senza build. Il lettore di codici a barre usa `BarcodeDetector` dove esiste e altrimenti [ZXing](https://github.com/zxing-js/library) (MIT), incluso in `vendor/`. Un service worker rende l'app utilizzabile offline.
