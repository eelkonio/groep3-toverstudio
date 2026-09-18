# Projectspecificatie: Digibord AI Toverstudio (Groep 3 Talentendag)

## 1. Projectoverzicht & Doel
Een interactieve, realtime webapplicatie ontworpen voor gebruik op een **digibord (smartboard/touchscreen)** in een klaslokaal met kinderen van ongeveer 6 jaar oud (groep 3 basisonderwijs).

Kinderen stellen aan de linkerkant een karakter samen door visuele stickers (ogen, monden, tanden, vleugels, kastelen, hoorns) op een canvas te slepen en er vrij bij te tekenen met felle viltstiften. Onder het canvas kiezen ze via een grote pictogrammenbalk hun 'intentie' (bijv. *"Lieve roze draak"* of *"Gekke bosfee"*). 

Aan de rechterkant van het scherm wordt de compositie **doorlopend (debounced / continu)** omgetoverd tot een hoogwaardige 3D Pixar-stijl animatiewereld via een ultrasnelle Image-to-Image pipeline. Het karakter kan zichzelf vervolgens voorstellen met een grappige stem.

---

## 2. Architectuur & Lokaal Ecosysteem

De gehele setup draait lokaal op de laptop van de docent/begeleider, aangesloten op het digibord:
- **Client (Frontend):** Touch-geoptimaliseerde single-page applicatie (HTML5, Fabric.js / Konva.js, CSS Grid/Flexbox).
- **Lokale Backend (Node.js/Express):**
  - Serveert de frontend.
  - Houdt API-sleutels veilig in een `.env` bestand.
  - Biedt proxy-routes voor externe AI-calls:
    1. **Fal.ai proxy (`/api/render-live`):** Flux Schnell of SD-Turbo Img2Img (synchroon, lage latency).
    2. **Gemini Vision proxy (`/api/describe-character`):** Analyseert het gerenderde 3D-karakter.
    3. **ElevenLabs proxy (`/api/tts`):** Genereert kinder-/cartoonstem audio zonder CORS-blokkades.

---

## 3. UI Layout & Digibord Interactie

De interface gebruikt een fullscreen landscape-verdeling (resolutie minimaal 1920x1080):

```
+------------------+----------------------------------+----------------------------------+
| ZIJBANK          | ZONE 1: SAMENSTELLEN & TEKENEN   | ZONE 2: LIVE MAGIE               |
| (Sticker Dock)   |                                  |                                  |
| [Tab: Gezicht]   |  +----------------------------+  |  +----------------------------+  |
| - 👀 Ogen        |  |                            |  |  |                            |  |
| - 👄 Monden      |  |     Fabric.js Canvas       |  |  |   Gegenereerde 3D Afbeelding|  |
| - 🦷 Tanden      |  |     (Touch, Drag, Teken)   |  |  |   (Live Update na actie)   |  |
| [Tab: Attributen]|  |                            |  |  |                            |  |
| - 🪽 Vleugels    |  +----------------------------+  |  +----------------------------+  |
| - 👑 Kroontjes   |  Palet: [🔴][🟢][🔵][🟡][🧽 Gum]  |  Status: "✨ Draakje is wakker!" |
| - 🏰 Kasteel     |  +----------------------------+  |  +----------------------------+  |
| - 🦄 Hoorns      |  | INTENTIEBALK (Thema-knoppen)|  |  | 🔊 [SPREEK OP FOTO TIKKEN] |  |
| [🗑️ Alles Leeg]  |  | [🐉 Draak] [🧚 Fee] [👾 Mon]|  |  | "Hoi! Ik ben Flubbel!"     |  |
+------------------+----------------------------------+----------------------------------+
```

### UX Eisen voor 6-Jarigen:
1. **Grote Touch Targets:** Knoppen zijn minimaal 90x90px met duidelijke tactiele feedback (klikgeluid en visuele scale-down).
2. **Geen Typwerk:** Alles werkt via pictogrammen, emoji's en grote letters.
3. **Geen Complexe Gestures:** Stickers kunnen met één vinger worden versleept. Dubbeltik verwijdert een sticker; een eenvoudige hoek-pin verzorgt schaling.
4. **Tekenen + Plakken gecombineerd:** Het kind kan een mond plakken en er direct een baard of snor omheen tekenen met de viltstift.

---

## 4. Technische Specificatie

### 4.1 Backend (`server.js` + `.env`)

```env
PORT=3000
FAL_KEY=jouw_fal_key
GEMINI_API_KEY=jouw_gemini_api_key
ELEVENLABS_API_KEY=jouw_elevenlabs_key
ELEVENLABS_VOICE_ID=jouw_geselecteerde_cartoon_stem_id
```

#### Endpoints:
- `POST /api/render-live`
  - **Payload:** `{ imageBase64: string, theme: string }`
  - **Actie:** Doorschakelen naar Fal.ai `fal-ai/flux/schnell/image-to-image` (of `fast-sdxl/image-to-image`).
  - **Prompt template:**
    `"A vibrant, cute 3D friendly ${theme}, Pixar Disney style, soft studio lighting, vivid bright colors, clean simple background, 3d render, claymation feel, highly detailed"`
  - **Strength / Denoising:** `0.62 - 0.68` (Cruciaal: hoog genoeg voor 3D magie, laag genoeg om de locatie van ogen/mond/elementen intact te houden).
  - **Inference steps:** 4 steps (voor < 1 seconde reactietijd).
  - **Return:** `{ imageUrl: string }`

- `POST /api/speak`
  - **Payload:** `{ imageUrl: string, theme: string }`
  - **Actie:**
    1. Gemini 1.5 Flash inspecteert de gerenderde afbeelding.
    2. Prompt: *"Kijk naar dit schattige 3D karakter. Bedenk voor een kind van 6 jaar in het Nederlands: 1) Een grappige naam, 2) Een ondeugende superkracht (max 8 woorden). Geef een ultrakorte introductiezin: 'Hoi! Ik ben [naam] en [superkracht]!'."*
    3. Stuur de gegenereerde zin direct door naar ElevenLabs `v1/text-to-speech/${ELEVENLABS_VOICE_ID}`.
  - **Return:** Audio/mpeg stream of JSON met `{ audioBase64: string, transcript: string }`.

---

### 4.2 Frontend Logica & Realtime Flow

#### Debounce Mechanisme (Realtime simulatie):
Om de API niet te overspoelen bij elke pixelbeweging:
```javascript
let renderTimeout = null;
const DEBOUNCE_DELAY_MS = 650; // Wacht 650ms na laatste aanraking

function scheduleRender() {
  setMagicStatus("⏳ Toveren...");
  clearTimeout(renderTimeout);
  renderTimeout = setTimeout(executeLiveRender, DEBOUNCE_DELAY_MS);
}

// Koppel aan canvas events in Fabric.js
canvas.on('object:modified', scheduleRender);
canvas.on('object:added', scheduleRender);
canvas.on('path:created', scheduleRender); // Na afronden van een getekende stift-lijn
```

#### Sticker Systeem:
Ondersteun zowel Unicode SVG-stickers als transparante PNG assets:
- **Gezichten:** Grote ogen, knipoog, drakenogen, vampiertanden, grote glimlach, snor.
- **Accessoires:** Drakenvleugels, feeënvleugels, ridderhelm, kroontje, toverstaf, feesthoedje.
- **Omgeving:** Kasteeltorentje, wolk, regenboog, paddenstoel.

#### Intentiebalk Knoppen:
- 🐉 `lieve roze draak`
- 🧚 `kleine bosfee tussen paddenstoelen`
- 🏰 `stoere kleine ridder in glimmend harnas`
- 👾 `harig vrolijk knuffelmonster`
- 🚀 `schattig ruimtewezen op een verre planeet`

---

## 5. Implementatiestappen voor de AI Agent

1. **Setup & Dependencies:**
   - Maak een Node.js project aan met `express`, `cors`, `dotenv`, en `node-fetch`.
   - Richt een statische map `public/` in voor de frontend assets.
2. **Server Endpoints:**
   - Bouw de proxy routes `/api/render-live` en `/api/speak` conform paragraaf 4.1.
   - Implementeer nette error handling met fallbacks (als ElevenLabs faalt, geef de tekst terug zodat de browser Web Speech API kan inspringen).
3. **Canvas Engine (Frontend):**
   - Integreer `fabric.js` (via CDN) voor touch-manipulatie van stickers en vrije stift-streken.
   - Bouw de zijbalk met stickers en categorie-tabs.
   - Voeg een stiftkleuren-palet toe (Rood, Blauw, Groen, Geel, Paars, Zwart) en een gum.
4. **Realtime Bridge & Audio:**
   - Koppel de debounced export van het canvas aan de `/api/render-live` route.
   - Zorg voor een cross-fade overgang tussen gerenderde afbeeldingen voor een vloeiend visueel effect.
   - Koppel een klik op het AI-resultaat (of een grote knop `🔊 Laat horen!`) aan `/api/speak` en speel de audio direct af via een `new Audio()`.
5. **Digibord Optimalisaties:**
   - Voeg `touch-action: none` en `-webkit-touch-callout: none` toe om onbedoeld zoomen of contextmenu's op het digibord te blokkeren.
   - Zorg voor een duidelijke resetknop (`🗑️ Opnieuw beginnen`) met een kindvriendelijke bevestigingsanimatie.