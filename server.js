/**
 * Digibord AI Toverstudio - lokale backend.
 *
 * Serveert de frontend uit /public en biedt drie proxy-routes zodat API-sleutels
 * nooit in de browser terechtkomen:
 *
 *   POST /api/render-live   -> Fal.ai image-to-image (snelle 4-step SDXL Lightning)
 *   POST /api/speak         -> Gemini Vision (naam + superkracht) -> ElevenLabs (stem)
 *   GET  /api/health        -> welke sleutels zijn geconfigureerd
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import jpeg from 'jpeg-js';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;

const FAL_KEY = process.env.FAL_KEY;

// Twee routes. 'controlnet' is de standaard: een text-to-image model waarbij de
// tekening alleen de structuur bepaalt en het model kleur, vacht, licht en
// achtergrond zelf verzint. 'img2img' is de oude route, als terugval.
const FAL_MODE = (process.env.FAL_MODE || 'controlnet').toLowerCase() === 'img2img'
  ? 'img2img'
  : 'controlnet';

const FAL_MODEL =
  process.env.FAL_MODEL ||
  (FAL_MODE === 'controlnet' ? 'fal-ai/sdxl-controlnet-union' : 'fal-ai/fast-sdxl/image-to-image');

// Hoe leidend is de tekening? 0 = model negeert hem, 1 = tekening volledig
// leidend. Gemeten op een echte kleutertekening: 0.35 verzint bijna alles,
// 0.5 houdt de opzet herkenbaar (open mond, armen wijd, geplakte stickers),
// 0.65 gaf een zwart beeld.
const FAL_CONTROL_SCALE = clamp(
  Number.isFinite(Number(process.env.FAL_CONTROL_SCALE)) ? Number(process.env.FAL_CONTROL_SCALE) : 0.5,
  0,
  1,
);

// Alleen voor de img2img-route.
const FAL_STRENGTH = clamp(Number(process.env.FAL_STRENGTH) || 0.9, 0.05, 1);
// Bij img2img is het aantal echte stappen num_inference_steps * strength.
// Met strength 0.65 heb je dus ~18 * 0.65 = 12 echte stappen: genoeg om de
// tekening om te toveren tot 3D, terwijl ogen en mond op hun plek blijven.
//
// Niet terugzetten naar fast-lightning-sdxl met 4 stappen: dat haalt ~2,6 echte
// stappen en levert bijna een kopie van de tekening op. Op 8 stappen geeft dat
// model juist een volledig zwarte afbeelding (gemeten), want het is op 4
// stappen gedistilleerd.
// De queue-API in plaats van een lange synchrone HTTP-call. Een cold start van
// het controlnet-model duurt tot ~70 seconden en die verbinding brak bij ons af
// met EADDRNOTAVAIL. Bij de queue pollen we op een request_id: pollen kost geen
// credits, en als een poll mislukt pakken we dezelfde render weer op in plaats
// van een nieuwe te starten.
const FAL_USE_QUEUE = process.env.FAL_USE_QUEUE !== 'false';
const FAL_MAX_WAIT_MS = Number(process.env.FAL_MAX_WAIT_MS) || 180000;

const FAL_STEPS = Number(process.env.FAL_STEPS) || 30;
const FAL_GUIDANCE = Number(process.env.FAL_GUIDANCE) || 8;

// Alleen voor de img2img-route: hoe grof we de tekening maken voordat hij naar
// het model gaat (verkleinen naar SOFTEN_GRID en weer bilineair opblazen).
//
// Waarom dat daar nodig was: een kleutertekening is bijna helemaal wit met
// dunne stiftlijnen. Wit blijft wit in img2img, dus het model kan daar geen
// vacht of massa verzinnen en poetst alleen de lijnen op, bij elke strength.
//
// De controlnet-route heeft dit niet nodig: die krijgt de tekening juist als
// lijnenkaart en regelt de vrijheid met FAL_CONTROL_SCALE.
const SOFTEN_GRID = Number.isFinite(Number(process.env.FAL_SOFTEN))
  ? Number(process.env.FAL_SOFTEN)
  : 32;

/**
 * Welke motor tekent het beeld?
 *
 *   gemini (standaard) - begrijpt de schets inhoudelijk. Een getekende raket
 *                        wordt een raket, met de raampjes en de vlam op hun
 *                        plek. Geen cold starts, geen zwarte frames.
 *   fal                - ControlNet of img2img. Volgt de compositie strakker,
 *                        maar weet niet wát er staat. Terugval als Gemini
 *                        dienst weigert of quota op is.
 */
const RENDER_ENGINE =
  (process.env.RENDER_ENGINE || 'gemini').toLowerCase() === 'fal' ? 'fal' : 'gemini';

/** Leest de sleutel uit een dotfile: losse sleutel of KEY=VALUE. */
function readKeyFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    if (!raw) return null;
    const match = /^(?:GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*(.+)$/m.exec(raw);
    return (match ? match[1] : raw.split('\n')[0]).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Sleutel uit .env, of anders uit dezelfde dotfiles die ~/bin/generate_image
 * gebruikt. Zo hoef je hem niet twee keer te zetten.
 */
function resolveGeminiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
  const home = process.env.HOME || '';
  for (const file of [
    process.env.GEMINI_API_KEY_FILE,
    home && path.join(home, '.gemini_api_key'),
    home && path.join(home, '.config', 'gemini', 'api_key'),
  ]) {
    if (!file) continue;
    const key = readKeyFile(file);
    if (key) return key;
  }
  return null;
}

const GEMINI_API_KEY = resolveGeminiKey();
// Tekstmodel voor de introductiezin. gemini-2.5-flash gaf hier een 404 met
// "no longer available to new users", met verwijzing naar gemini-3.6-flash.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';

// 'random' pakt een willekeurige stem uit de pool, zodat de kinderen niet
// steeds dezelfde stem horen. 'thema' gebruikt ELEVENLABS_VOICE_ID_<THEMA>,
// wat alleen werkt met een betaald ElevenLabs-plan: die vijf zijn
// library-stemmen en geven op het gratis plan 402 paid_plan_required.
const ELEVENLABS_VOICE_MODE =
  (process.env.ELEVENLABS_VOICE_MODE || 'random').toLowerCase() === 'thema' ? 'thema' : 'random';

const ELEVENLABS_VOICE_POOL = (process.env.ELEVENLABS_VOICE_POOL || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

/** Onthoudt de vorige stem, zodat we niet twee keer op rij dezelfde pakken. */
let lastVoiceId = null;

function voiceForTheme(intentId) {
  const key = String(intentId || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const themeVoice = key ? process.env[`ELEVENLABS_VOICE_ID_${key}`] : null;

  if (ELEVENLABS_VOICE_MODE === 'thema' && themeVoice) return themeVoice;

  if (ELEVENLABS_VOICE_POOL.length) {
    const choices =
      ELEVENLABS_VOICE_POOL.length > 1
        ? ELEVENLABS_VOICE_POOL.filter((id) => id !== lastVoiceId)
        : ELEVENLABS_VOICE_POOL;
    const picked = choices[Math.floor(Math.random() * choices.length)];
    lastVoiceId = picked;
    return picked;
  }

  return themeVoice || ELEVENLABS_VOICE_ID || null;
}

// Elke render wordt bewaard (input + output) zodat je kunt nakijken wat er misgaat.
const IMAGE_DIR = path.join(__dirname, 'generated-images');
const SAVE_IMAGES = process.env.SAVE_IMAGES !== 'false';

if (SAVE_IMAGES) fs.mkdirSync(IMAGE_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * In-memory cache van de laatst gerenderde afbeelding.
 * Zo hoeft de browser geen megabytes base64 terug te sturen bij /api/speak.
 * @type {Map<string, {mime: string, base64: string, theme: string}>}
 */
const renderCache = new Map();
const RENDER_CACHE_MAX = 12;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rememberRender(entry) {
  const renderId = `r${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
  renderCache.set(renderId, entry);
  while (renderCache.size > RENDER_CACHE_MAX) {
    const oldest = renderCache.keys().next().value;
    renderCache.delete(oldest);
  }
  return renderId;
}

/** Splitst een data-URI op in mime + base64. Geeft null bij een gewone URL. */
function parseDataUri(value) {
  if (typeof value !== 'string') return null;
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value.trim());
  if (!match) return null;
  return { mime: match[1], base64: match[2] };
}

/** Zorgt dat we altijd een volledige data-URI hebben om naar Fal te sturen. */
function toDataUri(imageBase64) {
  if (typeof imageBase64 !== 'string' || imageBase64.length < 32) return null;
  const trimmed = imageBase64.trim();
  if (trimmed.startsWith('data:')) return trimmed;
  return `data:image/jpeg;base64,${trimmed}`;
}

/* ------------------------------------------------------------------ */
/* Bewaren van afbeeldingen (voor debuggen en om werk te bewaren)       */
/* ------------------------------------------------------------------ */

function timestamp() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'geen-thema';
}

function extensionFor(mime) {
  if (/png/i.test(mime)) return 'png';
  if (/webp/i.test(mime)) return 'webp';
  return 'jpg';
}

/**
 * Schrijft een afbeelding naar generated-images/.
 * Bestanden worden nooit overschreven: bij een botsing komt er een teller bij.
 */
async function saveImage({ base64, mime, theme, kind, stamp, childName }) {
  if (!SAVE_IMAGES || !base64) return null;

  // De naam van het kind zit in de bestandsnaam zodat de leerkracht achteraf
  // de juiste plaatjes en audio naar de juiste ouders kan sturen.
  const who = childName ? `${slugify(childName)}__` : '';
  const name = `${stamp}__${who}${slugify(theme)}__${kind}.${extensionFor(mime)}`;
  let target = path.join(IMAGE_DIR, name);
  let counter = 1;
  while (fs.existsSync(target)) {
    target = path.join(IMAGE_DIR, name.replace(/(\.[a-z]+)$/, `-${counter}$1`));
    counter += 1;
  }

  try {
    await fsp.writeFile(target, Buffer.from(base64, 'base64'));
    const bytes = (await fsp.stat(target)).size;
    console.log(`[bewaard] ${path.basename(target)} (${Math.round(bytes / 1024)} kB)`);
    return target;
  } catch (error) {
    console.error('[bewaren mislukt]', error.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Zwartdetectie                                                       */
/* ------------------------------------------------------------------ */

// Het fal img2img-endpoint levert af en toe een volledig zwart beeld op.
// Niet reproduceerbaar: dezelfde seed en instellingen gaven de ene keer zwart
// en de andere keer een goed resultaat, met has_nsfw_concepts op false.
//
// We keuren zo'n frame af maar proberen het NIET automatisch opnieuw: een
// retry-lus kan ongemerkt credits opeten. Het vorige goede beeld blijft staan
// en de volgende tekenactie zorgt vanzelf voor een nieuwe poging.
const DARK_LUMA_THRESHOLD = 14;

/** Gemiddelde helderheid (0-255) van een JPEG, of null als het niet lukt. */
function averageLuma(buffer) {
  try {
    const { data, width, height } = jpeg.decode(buffer, { useTArray: true });
    const step = Math.max(1, Math.floor((width * height) / 20000)) * 4;
    let total = 0;
    let samples = 0;
    for (let i = 0; i < data.length - 3; i += step) {
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      samples += 1;
    }
    return samples ? total / samples : null;
  } catch (error) {
    console.error('[zwartdetectie] decoderen mislukt:', error.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Tekening verzachten                                                 */
/* ------------------------------------------------------------------ */

/**
 * Verkleint naar `grid` x `grid` en blaast bilineair terug op.
 * Resultaat: zachte kleurvlakken waar het model zelf vorm aan mag geven.
 */
function softenDrawing(buffer, grid) {
  const { data, width, height } = jpeg.decode(buffer, { useTArray: true });

  const small = new Float32Array(grid * grid * 3);
  const counts = new Float32Array(grid * grid);

  for (let y = 0; y < height; y++) {
    const ty = Math.min(grid - 1, Math.floor((y / height) * grid));
    for (let x = 0; x < width; x++) {
      const tx = Math.min(grid - 1, Math.floor((x / width) * grid));
      const si = (ty * grid + tx) * 3;
      const di = (y * width + x) * 4;
      small[si] += data[di];
      small[si + 1] += data[di + 1];
      small[si + 2] += data[di + 2];
      counts[ty * grid + tx] += 1;
    }
  }
  for (let i = 0; i < grid * grid; i++) {
    const count = counts[i] || 1;
    small[i * 3] /= count;
    small[i * 3 + 1] /= count;
    small[i * 3 + 2] /= count;
  }

  const sample = (x, y, channel) => {
    const cx = Math.min(grid - 1, Math.max(0, x));
    const cy = Math.min(grid - 1, Math.max(0, y));
    return small[(cy * grid + cx) * 3 + channel];
  };

  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const fy = (y / height) * grid - 0.5;
    const y0 = Math.floor(fy);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = (x / width) * grid - 0.5;
      const x0 = Math.floor(fx);
      const wx = fx - x0;
      const di = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = sample(x0, y0, c) * (1 - wx) + sample(x0 + 1, y0, c) * wx;
        const bottom = sample(x0, y0 + 1, c) * (1 - wx) + sample(x0 + 1, y0 + 1, c) * wx;
        out[di + c] = Math.round(top * (1 - wy) + bottom * wy);
      }
      out[di + 3] = 255;
    }
  }

  return jpeg.encode({ data: out, width, height }, 88).data;
}

/* ------------------------------------------------------------------ */
/* Thema's                                                             */
/* ------------------------------------------------------------------ */

/**
 * De vaste opdracht aan het model: neem de tekening zoals hij is.
 * Bewust zonder onderwerp, zodat de schets zelf de voorgrond bepaalt.
 * Aanpasbaar via FAL_LEAD in .env.
 */
const SKETCH_LEAD =
  process.env.FAL_LEAD ||
  'Convert this sketch into pixar style version, change this rough sketch into a proper image';

/**
 * Stijlstaart. Kort gehouden: lange stijlreeksen gaan de tekening weer
 * overstemmen. Aanpasbaar via FAL_STYLE in .env.
 */
const FAL_STYLE =
  process.env.FAL_STYLE || 'colourful, highly detailed, soft cinematic lighting, 3d render';

/**
 * Per thema alleen de wereld eromheen. De voorgrond komt uit de tekening.
 *
 * Eerder stond hier het onderwerp per thema ("one single cute baby dragon",
 * "a chunky toy-like rocket ship"). Die beschrijving overstemde de tekening:
 * wie bij het ruimtethema een raket tekende kreeg alsnog een pluizig beestje,
 * omdat de eigenschappen uit de prompt kwamen in plaats van uit de schets.
 *
 * `avoid` komt bovenop de basis-negatives.
 */
const THEME_PROMPTS = {
  draak: {
    scene: 'in the background add misty fantasy mountains and a dramatic cloudy sky',
    avoid: 'multiple creatures, group of animals, human, rider',
  },
  fee: {
    scene:
      'in the background add a magical forest with giant mushrooms, glowing pollen and soft dappled light',
    avoid: 'multiple creatures, group, scary, adult woman',
  },
  ridder: {
    scene: 'in the background add a medieval castle, colourful banners and a grassy field',
    avoid: 'multiple knights, army, group, blood, weapons pointed at viewer',
  },
  monster: {
    scene: 'in the background add a colourful playful monster world with soft rolling hills',
    avoid: 'multiple creatures, group, scary, sharp teeth, menacing',
  },
  ruimte: {
    scene: 'in the background add space nebulas, stars and distant planets',
    // 'animal' en 'creature' staan hier bewust niet in: bij dit thema mag een
    // kind ook een beestje in de ruimte tekenen. De voorgrond is vrij.
    avoid: 'face on the rocket, scary',
  },
};

const DEFAULT_THEME = {
  scene: 'in the background add a simple soft colourful backdrop',
  avoid: '',
};

/** Haalt rare tekens uit vrije invoer voordat die de prompt in gaat. */
function cleanText(value, maxLength) {
  return String(value || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/** Zoekt het thema op. `theme` mag ook een vrije scènebeschrijving zijn. */
function resolveTheme({ intentId, theme }) {
  const key = cleanText(intentId, 40).toLowerCase();
  if (THEME_PROMPTS[key]) return THEME_PROMPTS[key];

  const free = cleanText(theme, 240);
  if (free) return { scene: free, avoid: '' };

  return DEFAULT_THEME;
}

/**
 * Bouwt prompt en negative prompt.
 *
 * Opbouw: opdracht (neem de tekening zoals hij is), dan de wereld van het
 * thema, dan de gekozen kleur, dan de eigen beschrijving, dan de stijl.
 *
 * Er staat bewust geen onderwerp in. De tekening bepaalt de voorgrond.
 *
 * Let op: in controlnet-modus gebruikt het model alleen de lijnen van de
 * tekening, niet de kleuren. Kleur komt dus hieruit. Daarom ook geen kleur in
 * de basistekst: eerder stond hier "candy colors" en "pastel background" en
 * dan werd letterlijk elk beestje roze.
 */
function buildPrompt({ intentId, theme, colors, extra } = {}) {
  const resolved = resolveTheme({ intentId, theme });
  const parts = [SKETCH_LEAD, resolved.scene];

  const colorWords = cleanText(colors, 80);
  if (colorWords) parts.push(`mainly ${colorWords} colors`);

  const own = cleanText(extra, 160);
  if (own) parts.push(own);

  parts.push(FAL_STYLE);

  const negative = [NEGATIVE_PROMPT, cleanText(resolved.avoid, 200)].filter(Boolean).join(', ');
  return { prompt: parts.filter(Boolean).join(', '), negative };
}

/**
 * Zet een Gemini-fout om in iets begrijpelijks.
 * `blocking` betekent: doorproberen is zinloos tot iemand iets aanpast, dan
 * pauzeert de renderlus in de browser in plaats van credits te blijven stoken.
 */
function explainGeminiError(status, detail) {
  const body = String(detail || '');

  if (status === 503 || /geen Gemini-sleutel/i.test(body)) {
    return {
      reason: 'gemini_no_key',
      message: 'Geen Gemini-sleutel gevonden. Zet hem in .env of ~/.gemini_api_key.',
      blocking: true,
    };
  }
  if (status === 401 || status === 403) {
    return {
      reason: 'gemini_auth',
      message: 'Gemini accepteert de sleutel niet. Controleer GEMINI_API_KEY.',
      blocking: true,
    };
  }
  if (status === 429) {
    return {
      reason: 'gemini_quota',
      message: 'Gemini is even vol of je quotum is op. Overweeg RENDER_ENGINE=fal in .env.',
      blocking: true,
    };
  }
  if (status === 404) {
    return {
      reason: 'gemini_model',
      message: `Model "${GEMINI_IMAGE_MODEL}" bestaat niet. Pas GEMINI_IMAGE_MODEL aan.`,
      blocking: true,
    };
  }
  // Veiligheidsfilter of alleen tekst terug: eenmalig, gewoon opnieuw tekenen.
  if (/SAFETY|blockReason|geen afbeelding/i.test(body)) {
    return {
      reason: 'gemini_no_image',
      message: 'Gemini wilde hier geen plaatje van maken. Teken iets anders, dan gaat hij opnieuw.',
      blocking: false,
    };
  }
  return {
    reason: 'gemini_failed',
    message: 'De tovenaar struikelde even. Probeer het nog een keer.',
    blocking: false,
  };
}

/**
 * Zet een Fal-foutstatus om in iets dat op het digibord te begrijpen is.
 * `blocking` betekent: doorproberen is zinloos tot iemand iets aanpast.
 */
function explainFalError(status, detail) {
  const body = String(detail || '');

  if (status === 403 && /TOP_UP|locked/i.test(body)) {
    return {
      reason: 'fal_no_credit',
      message: 'Geen tegoed meer bij fal.ai. Waardeer het account op om te toveren.',
      blocking: true,
    };
  }
  if (status === 401 || status === 403) {
    return {
      reason: 'fal_auth',
      message: 'De FAL_KEY wordt niet geaccepteerd. Controleer de sleutel in .env.',
      blocking: true,
    };
  }
  if (status === 404) {
    return {
      reason: 'fal_model',
      message: `Model "${FAL_MODEL}" bestaat niet. Pas FAL_MODEL aan in .env.`,
      blocking: true,
    };
  }
  if (status === 422) {
    return {
      reason: 'fal_input',
      message: 'Het model snapte de tekening niet. Probeer iets anders te plakken.',
      blocking: false,
    };
  }
  if (status === 429) {
    return {
      reason: 'fal_rate',
      message: 'Te veel toverspreuken tegelijk. Even wachten.',
      blocking: false,
    };
  }
  return {
    reason: 'fal_failed',
    message: 'De tovenaar struikelde even. Probeer het nog een keer.',
    blocking: false,
  };
}

// De dikke stiftlijnen mogen geen meubels, buizen of frames worden: dat gebeurde
/** Bouwt de request-body voor de gekozen route. */
function buildFalBody({ imageDataUri, intentId, theme, colors, extra }) {
  const { prompt, negative } = buildPrompt({ intentId, theme, colors, extra });
  const shared = {
    prompt,
    negative_prompt: negative,
    num_inference_steps: FAL_STEPS,
    guidance_scale: FAL_GUIDANCE,
    image_size: 'square_hd',
    num_images: 1,
    format: 'jpeg',
    // Bij de directe call geeft sync_mode een data-URI terug (scheelt een
    // roundtrip). Via de queue halen we het resultaat toch apart op.
    sync_mode: !FAL_USE_QUEUE,
    enable_safety_checker: false,
  };

  if (FAL_MODE === 'controlnet') {
    return {
      ...shared,
      // TEED is een zachte lijndetector: werkt beter op dikke stiftstreken dan
      // canny, dat de contour van de streep pakt in plaats van de streep zelf.
      teed_image_url: imageDataUri,
      teed_preprocess: true,
      controlnet_conditioning_scale: FAL_CONTROL_SCALE,
    };
  }

  return { ...shared, image_url: imageDataUri, strength: FAL_STRENGTH };
}

// Kwaliteit en veiligheid, geldt voor elk thema. Themaspecifieke negatieven
// staan in THEME_PROMPTS.avoid.
const NEGATIVE_PROMPT =
  'text, letters, watermark, signature, logo, ' +
  'flat, 2d, flat colors, childrens drawing, crayon, marker outline, clipart, sketch, ' +
  'scary, horror, creepy, gore, blood, blurry, low quality, deformed, ' +
  'photorealistic human, ugly, grim';

// Voor de wezen-thema's: dikke stiftlijnen mogen geen meubels of frames worden.
// Niet bij ruimte, want een raket is nu juist een buis met een punt.
const NO_PROPS = 'furniture, chair, table, bench, frame, hoop, tube, pipe, wire, rope';

for (const themeKey of ['draak', 'fee', 'ridder', 'monster']) {
  THEME_PROMPTS[themeKey].avoid = `${THEME_PROMPTS[themeKey].avoid}, ${NO_PROPS}`;
}

/** Haalt een afbeelding op als base64, of het nu een data-URI of https-URL is. */
async function resolveImageBytes({ renderId, imageUrl }) {
  if (renderId && renderCache.has(renderId)) {
    const cached = renderCache.get(renderId);
    return { mime: cached.mime, base64: cached.base64 };
  }

  const inline = parseDataUri(imageUrl);
  if (inline) return inline;

  if (typeof imageUrl === 'string' && /^https?:\/\//i.test(imageUrl)) {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Kon afbeelding niet ophalen (${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mime = response.headers.get('content-type') || 'image/jpeg';
    return { mime: mime.split(';')[0], base64: buffer.toString('base64') };
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Fal aanroepen                                                       */
/* ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function falHeaders() {
  return { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };
}

/** Directe call. Simpel, maar de verbinding moet de hele render openblijven. */
async function falDirect(body) {
  const response = await fetch(`https://fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: falHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FAL_MAX_WAIT_MS),
  });

  if (!response.ok) {
    return { failed: { status: response.status, detail: await response.text() } };
  }
  return { payload: await response.json() };
}

/**
 * Via de queue: één keer insturen, daarna pollen op de status.
 * Een mislukte poll is niet erg, die proberen we gewoon opnieuw: de render
 * loopt door op fal en er wordt geen tweede inference gestart.
 */
async function falQueued(body) {
  const submit = await fetch(`https://queue.fal.run/${FAL_MODEL}`, {
    method: 'POST',
    headers: falHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!submit.ok) {
    return { failed: { status: submit.status, detail: await submit.text() } };
  }

  const { request_id: requestId, status_url: statusUrl, response_url: responseUrl } =
    await submit.json();

  if (!statusUrl || !responseUrl) {
    return { failed: { status: 502, detail: 'queue gaf geen status-url terug' } };
  }

  const deadline = Date.now() + FAL_MAX_WAIT_MS;
  let delay = 500;
  let pollFailures = 0;

  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(2500, Math.round(delay * 1.25));

    let status;
    try {
      const response = await fetch(statusUrl, {
        headers: falHeaders(),
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) {
        pollFailures += 1;
        continue;
      }
      status = await response.json();
      pollFailures = 0;
    } catch {
      // Verbinding brak: opnieuw pollen, de render loopt door bij fal.
      pollFailures += 1;
      if (pollFailures > 40) {
        return { failed: { status: 504, detail: 'status niet meer op te vragen' } };
      }
      continue;
    }

    if (status.status === 'COMPLETED') {
      if (status.error) {
        return { failed: { status: 502, detail: String(status.error) } };
      }

      // Splitst de wachttijd: hoeveel was wachten op een runner (fal schaalt op)
      // en hoeveel was het renderen zelf. Bepaalt of opwarmen zin heeft.
      const totalSec = (Date.now() - (deadline - FAL_MAX_WAIT_MS)) / 1000;
      const inferenceSec = Number(status?.metrics?.inference_time) || null;
      console.log(
        `[fal] klaar in ${totalSec.toFixed(1)}s` +
          (inferenceSec
            ? ` (renderen ${inferenceSec.toFixed(1)}s, wachten op runner ${(
                totalSec - inferenceSec
              ).toFixed(1)}s)`
            : ''),
      );
      const result = await fetch(responseUrl, {
        headers: falHeaders(),
        signal: AbortSignal.timeout(60000),
      });
      if (!result.ok) {
        return { failed: { status: result.status, detail: await result.text() } };
      }
      return { payload: await result.json() };
    }
  }

  console.warn(`[fal] wachttijd verstreken voor ${requestId}`);
  return { failed: { status: 504, detail: 'wachttijd verstreken' } };
}

function callFal(body) {
  return FAL_USE_QUEUE ? falQueued(body) : falDirect(body);
}

/* ------------------------------------------------------------------ */
/* Gemini als rendermotor                                              */
/* ------------------------------------------------------------------ */

/**
 * Gemini kent geen negative prompt. De veiligheidskant daarvan zetten we als
 * gewone zin in de opdracht; de rest van de negatieven laten we vallen, want
 * dingen opnoemen die je niet wil werkt bij dit model averechts.
 */
const GEMINI_GUARDRAIL =
  'Keep it friendly, cheerful and suitable for six year old children. ' +
  'No text, letters, logos or watermarks in the image.';

/** Rendert met Gemini. Geeft { base64, mime } of { failed }. */
async function renderWithGemini({ imageDataUri, prompt }) {
  if (!GEMINI_API_KEY) {
    return { failed: { status: 503, detail: 'geen Gemini-sleutel gevonden' } };
  }

  const parts = parseDataUri(imageDataUri);
  if (!parts) return { failed: { status: 400, detail: 'geen geldige tekening' } };

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent` +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(FAL_MAX_WAIT_MS),
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              // Afbeelding eerst, dan de opdracht: zo is de tekening referentie.
              { inline_data: { mime_type: parts.mime, data: parts.base64 } },
              { text: `${prompt}. ${GEMINI_GUARDRAIL}` },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    return { failed: { status: 502, detail: `verbinding met Gemini mislukte: ${error.message}` } };
  }

  if (!response.ok) {
    return { failed: { status: response.status, detail: await response.text() } };
  }

  const payload = await response.json();
  const candidate = payload?.candidates?.[0];

  // Antwoorden komen in camelCase terug, verzoeken mogen snake_case zijn.
  for (const part of candidate?.content?.parts || []) {
    const inline = part.inlineData || part.inline_data;
    if (inline?.data) {
      return { base64: inline.data, mime: inline.mimeType || inline.mime_type || 'image/png' };
    }
  }

  // Geen beeld: meestal een veiligheidsfilter of alleen tekst terug.
  const text = (candidate?.content?.parts || []).map((p) => p.text).filter(Boolean).join(' ');
  const reason = candidate?.finishReason || payload?.promptFeedback?.blockReason || 'onbekend';
  return {
    failed: { status: 502, detail: `Gemini gaf geen afbeelding (${reason}) ${text}`.trim() },
  };
}

/**
 * Eén goedkope render bij het opstarten, om het model warm te krijgen.
 *
 * Waarom: een cold start van het controlnet-model duurde bij ons 147 seconden,
 * warm was het 4 tot 5 seconden. Dat verschil krijg je precies één keer, bij de
 * eerste tekening. Start de server een paar minuten voor de les met
 * FAL_WARMUP=true, dan zit die wachttijd voor de les in plaats van erin.
 *
 * Staat standaard uit, want het kost een fractie van je fal-tegoed.
 */
async function warmUp() {
  // Alleen fal heeft dit nodig: Gemini is een gehoste API zonder cold start.
  if (RENDER_ENGINE !== 'fal' || !FAL_KEY || process.env.FAL_WARMUP !== 'true') return;

  const size = 512;
  const pixels = Buffer.alloc(size * size * 4, 0xdd);
  for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  const jpegBytes = jpeg.encode({ data: pixels, width: size, height: size }, 80).data;
  const dataUri = `data:image/jpeg;base64,${jpegBytes.toString('base64')}`;

  const body = {
    ...buildFalBody({ imageDataUri: dataUri, intentId: 'monster', colors: '', extra: '' }),
    num_inference_steps: 8, // zo goedkoop mogelijk: we willen alleen de opwarming
  };

  console.log('  Opwarmen...  (FAL_WARMUP=true)');
  const started = Date.now();
  const { failed } = await callFal(body);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  if (failed) {
    console.log(`  Opwarmen mislukt na ${seconds}s: ${String(failed.detail).slice(0, 120)}`);
  } else {
    console.log(`  Opgewarmd in ${seconds}s, de eerste tekening gaat nu snel.`);
  }
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    engine: RENDER_ENGINE,
    // De client checkt dit om te weten of renderen zin heeft.
    canRender: RENDER_ENGINE === 'gemini' ? Boolean(GEMINI_API_KEY) : Boolean(FAL_KEY),
    fal: Boolean(FAL_KEY),
    falModel: FAL_MODEL,
    gemini: Boolean(GEMINI_API_KEY),
    geminiImageModel: GEMINI_IMAGE_MODEL,
    elevenlabs: Boolean(ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID),
    mode: FAL_MODE,
    queue: FAL_USE_QUEUE,
    controlScale: FAL_CONTROL_SCALE,
    strength: FAL_STRENGTH,
    steps: FAL_STEPS,
    guidance: FAL_GUIDANCE,
    soften: FAL_MODE === 'img2img' ? SOFTEN_GRID : 0,
  });
});

/* ------------------------------------------------------------------ */
/* 1. Live render: canvas -> 3D Pixar-stijl karakter                   */
/* ------------------------------------------------------------------ */

app.post('/api/render-live', async (req, res) => {
  const { imageBase64, intentId, theme, colors, extra } = req.body || {};
  const childName = cleanText(req.body?.childName, 40);

  if (RENDER_ENGINE === 'gemini' && !GEMINI_API_KEY) {
    return res.status(503).json({
      error: 'missing_gemini_key',
      message: 'Geen Gemini-sleutel gevonden. Zet GEMINI_API_KEY in .env of ~/.gemini_api_key.',
      blocking: true,
    });
  }

  if (RENDER_ENGINE === 'fal' && !FAL_KEY) {
    return res.status(503).json({
      error: 'missing_fal_key',
      message: 'FAL_KEY ontbreekt in .env, de toverstudio kan nog niet renderen.',
      blocking: true,
    });
  }

  const dataUri = toDataUri(imageBase64);
  if (!dataUri) {
    return res.status(400).json({
      error: 'invalid_image',
      message: 'Geen geldige tekening ontvangen.',
    });
  }

  const startedAt = Date.now();
  const stamp = timestamp();
  // De client stuurt sinds de themaherziening intentId in plaats van theme.
  // Zonder deze fallback heetten alle bestanden "geen-thema".
  const label = theme || intentId;

  // Originele tekening bewaren zoals de browser hem stuurde.
  const inputParts = parseDataUri(dataUri);
  if (inputParts) {
    await saveImage({
      base64: inputParts.base64,
      mime: inputParts.mime,
      theme: label,
      kind: 'input-canvas',
      stamp,
      childName,
    });
  }

  // Verzachten is alleen nodig voor fal img2img. ControlNet wil juist de lijnen,
  // en Gemini begrijpt de tekening zoals hij is.
  let modelInput = dataUri;
  if (
    RENDER_ENGINE === 'fal' &&
    FAL_MODE === 'img2img' &&
    SOFTEN_GRID >= 8 &&
    inputParts &&
    /jpe?g/i.test(inputParts.mime)
  ) {
    try {
      const softened = softenDrawing(Buffer.from(inputParts.base64, 'base64'), SOFTEN_GRID);
      modelInput = `data:image/jpeg;base64,${softened.toString('base64')}`;
      await saveImage({
        base64: softened.toString('base64'),
        mime: 'image/jpeg',
        theme: label,
        kind: 'input-zacht',
        stamp,
      });
    } catch (error) {
      console.error('[verzachten mislukt, origineel gebruikt]', error.message);
    }
  }

  try {
    const { prompt, negative } = buildPrompt({ intentId, theme, colors, extra });
    console.log(`[prompt] (${RENDER_ENGINE}) ${prompt}`);

    let outputBase64 = '';
    let mime = 'image/jpeg';
    let remoteUrl = null;
    let failed = null;

    if (RENDER_ENGINE === 'gemini') {
      const result = await renderWithGemini({ imageDataUri: modelInput, prompt });
      failed = result.failed || null;
      if (result.base64) {
        outputBase64 = result.base64;
        mime = result.mime;
      }
    } else {
      const result = await callFal(
        buildFalBody({ imageDataUri: modelInput, intentId, theme, colors, extra }),
      );
      failed = result.failed || null;

      const image = result.payload?.images?.[0];
      if (!failed && !image?.url) {
        failed = { status: 502, detail: 'fal gaf geen afbeelding terug' };
      }
      if (image?.url) {
        const inline = parseDataUri(image.url);
        mime = inline?.mime || image.content_type || 'image/jpeg';
        outputBase64 = inline?.base64 || '';
        if (!outputBase64 && /^https?:\/\//i.test(image.url)) {
          remoteUrl = image.url;
          const fetched = await resolveImageBytes({ imageUrl: image.url }).catch(() => null);
          if (fetched) outputBase64 = fetched.base64;
        }
      }
    }

    if (failed || !outputBase64) {
      const detail = String(failed?.detail || 'geen afbeelding ontvangen');
      console.error(`[${RENDER_ENGINE}] error`, failed?.status, detail.slice(0, 500));
      const explained =
        RENDER_ENGINE === 'gemini'
          ? explainGeminiError(failed?.status, detail)
          : explainFalError(failed?.status, detail);
      return res.status(502).json({
        error: explained.reason,
        message: explained.message,
        blocking: explained.blocking,
        status: failed?.status,
        detail: detail.slice(0, 200),
      });
    }

    // Zwart frame? Afkeuren, wel bewaren om te kunnen nakijken, niet opnieuw
    // proberen. De client houdt dan het vorige beeld vast.
    const luma = /jpe?g/i.test(mime) ? averageLuma(Buffer.from(outputBase64, 'base64')) : null;
    if (luma !== null && luma < DARK_LUMA_THRESHOLD) {
      await saveImage({
        base64: outputBase64,
        mime,
        theme: label,
        kind: `output-${RENDER_ENGINE}-AFGEKEURD-zwart`,
        stamp,
        childName,
      });
      console.warn(`[${RENDER_ENGINE}] zwart frame afgekeurd (helderheid ${luma.toFixed(1)})`);
      return res.status(502).json({
        error: 'black_frame',
        message: 'Die toverspreuk mislukte. Teken of plak iets, dan gaat hij opnieuw.',
        blocking: false,
        luma: Number(luma.toFixed(1)),
      });
    }

    const savedPath = await saveImage({
      base64: outputBase64,
      mime,
      theme: label,
      kind: `output-${RENDER_ENGINE}`,
      stamp,
      childName,
    });

    const renderId = rememberRender({
      mime,
      base64: outputBase64,
      theme: label || '',
      url: remoteUrl,
      // Nodig voor /api/speak: de mp3 komt naast dit bestand te staan met
      // dezelfde basisnaam, en de stem hangt aan het thema.
      imagePath: savedPath,
      intentId: cleanText(intentId, 40),
      childName,
    });

    res.json({
      // Geen data-URI: een Gemini-PNG maakte de JSON 2,7 MB per render. De
      // browser haalt de bytes los op via deze route.
      imageUrl: `/api/image/${renderId}`,
      renderId,
      prompt,
      engine: RENDER_ENGINE,
      negative: RENDER_ENGINE === 'fal' ? negative : null,
      ms: Date.now() - startedAt,
    });
  } catch (error) {
    console.error('[render-live]', error);
    res.status(500).json({
      error: 'render_crashed',
      message: 'Toveren mislukte. Nog een keer proberen?',
    });
  }
});

/** Levert de bytes van een render uit de cache. */
app.get('/api/image/:renderId', (req, res) => {
  const entry = renderCache.get(req.params.renderId);
  if (!entry?.base64) return res.status(404).json({ error: 'not_found' });

  res.set('Content-Type', entry.mime || 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(Buffer.from(entry.base64, 'base64'));
});

/* ------------------------------------------------------------------ */
/* 2. Spreken: Gemini bedenkt de intro, ElevenLabs spreekt hem uit     */
/* ------------------------------------------------------------------ */

/**
 * Verteller in de hij/zij-vorm over het plaatje, niet meer de ik-vorm van het
 * karakter zelf. Twee zinnen, want dit wordt voorgelezen op een digibord.
 */
const GEMINI_PROMPT =
  'Kijk goed naar dit plaatje. Schrijf in het Nederlands een grappig, fantasievol ' +
  'verhaaltje van precies TWEE korte zinnen, voor kinderen van zes jaar. ' +
  'Beschrijf wat je op het plaatje ziet en verzin er iets leuks bij, ' +
  'bijvoorbeeld een naam of wat het wezen kan. ' +
  'Gebruik eenvoudige woorden en korte zinnen. ' +
  'Geef ALLEEN die twee zinnen, geen uitleg, geen opsomming, geen aanhalingstekens, ' +
  'geen emoji en geen titel.';

const FALLBACK_LINES = [
  'Dit is Flubbel, een heel vrolijk wezen. Hij kan toveren met zijn neus!',
  'Kijk, dat is Snorrepop! Zij niest glitters door de hele klas.',
  'Dit is Wobbeltand, het liefste wezen van de wereld. Hij danst graag op wolken!',
];

function fallbackLine() {
  return FALLBACK_LINES[Math.floor(Math.random() * FALLBACK_LINES.length)];
}

/** Vraagt Gemini om een introductiezin bij de afbeelding. */
async function describeCharacter({ mime, base64 }, theme) {
  if (!GEMINI_API_KEY) return null;

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent` +
    `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { text: `${GEMINI_PROMPT}${theme ? ` Het thema is: ${theme}.` : ''}` },
            { inline_data: { mime_type: mime || 'image/jpeg', data: base64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 1.1,
        maxOutputTokens: 2048,
        // Denken uitzetten: gemini-3.x rekent denk-tokens mee in het budget en
        // at zo de tweede zin op ("...een enorme hete vuurflits" en dan stop).
        // Voor twee zinnen valt er niets te denken, en het is ook sneller.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error('[gemini] error', response.status, detail.slice(0, 400));
    return null;
  }

  const payload = await response.json();
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .map((part) => part?.text || '')
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();

  return text || null;
}

/** Zet tekst om in mp3 via ElevenLabs. Geeft null als het niet lukt. */
async function synthesizeSpeech(text, intentId) {
  const voiceId = voiceForTheme(intentId);
  if (!ELEVENLABS_API_KEY || !voiceId) return null;

  const url =
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}` +
    '?output_format=mp3_44100_128';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: ELEVENLABS_MODEL,
      voice_settings: {
        stability: 0.35,
        similarity_boost: 0.75,
        style: 0.6,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    console.error('[elevenlabs] error', response.status, detail.slice(0, 400));
    return null;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.toString('base64');
}

/**
 * Zet de audio naast het plaatje: zelfde basisnaam, extensie .mp3.
 * Zo horen beeld en geluid van hetzelfde kind bij elkaar in de map.
 */
async function saveAudioNextToImage(imagePath, audioBase64) {
  if (!SAVE_IMAGES || !imagePath || !audioBase64) return null;

  let target = imagePath.replace(/\.[a-z0-9]+$/i, '.mp3');
  let counter = 1;
  while (fs.existsSync(target)) {
    target = imagePath.replace(/\.[a-z0-9]+$/i, `-${counter}.mp3`);
    counter += 1;
  }

  try {
    await fsp.writeFile(target, Buffer.from(audioBase64, 'base64'));
    console.log(`[bewaard] ${path.basename(target)} (${Math.round(Buffer.byteLength(audioBase64, 'base64') / 1024)} kB)`);
    return target;
  } catch (error) {
    console.error('[audio bewaren mislukt]', error.message);
    return null;
  }
}

/** Bestaat er al een mp3 naast dit plaatje? Dan die teruggeven. */
function readExistingAudio(imagePath) {
  if (!imagePath) return null;
  const candidate = imagePath.replace(/\.[a-z0-9]+$/i, '.mp3');
  try {
    if (!fs.existsSync(candidate)) return null;
    return fs.readFileSync(candidate).toString('base64');
  } catch {
    return null;
  }
}

app.post('/api/speak', async (req, res) => {
  const { imageUrl, renderId, theme } = req.body || {};
  const cached = renderId ? renderCache.get(renderId) : null;

  // Al een verhaaltje gemaakt voor dit plaatje? Dan dat afspelen. Zo kost een
  // tweede keer "laat horen" geen Gemini- en geen ElevenLabs-call, en hoort het
  // kind exact hetzelfde verhaal met dezelfde stem terug.
  if (cached?.audioBase64) {
    return res.json({
      transcript: cached.transcript || '',
      audioBase64: cached.audioBase64,
      voice: 'elevenlabs',
      reused: true,
    });
  }

  // Cache leeg maar het bestand staat er nog, bijvoorbeeld na een herstart.
  const onDisk = readExistingAudio(cached?.imagePath);
  if (onDisk && cached?.transcript) {
    return res.json({
      transcript: cached.transcript,
      audioBase64: onDisk,
      voice: 'elevenlabs',
      reused: true,
    });
  }

  // Naam uit het verzoek, of anders die van de render zelf.
  const childName = cleanText(req.body?.childName, 40) || cached?.childName || '';
  const intentId = cleanText(req.body?.intentId, 40) || cached?.intentId || '';

  try {
    let story = null;

    const bytes = await resolveImageBytes({ renderId, imageUrl }).catch((error) => {
      console.error('[speak] image', error.message);
      return null;
    });

    if (bytes?.base64) {
      story = await describeCharacter(bytes, theme).catch((error) => {
        console.error('[speak] gemini', error);
        return null;
      });
    }

    if (!story) story = fallbackLine();

    // Afsluiter met de naam van het kind: dat is het leukste stukje om te horen.
    // Punt erbij als het verhaaltje er geen heeft, anders loopt het aan elkaar.
    const rounded = /[.!?]$/.test(story) ? story : `${story}.`;
    const transcript = childName ? `${rounded} Verzonnen door ${childName}.` : rounded;

    const audioBase64 = await synthesizeSpeech(transcript, intentId).catch((error) => {
      console.error('[speak] tts', error);
      return null;
    });

    if (cached) {
      // Onthouden bij deze render, zodat een tweede keer "laat horen" geen
      // nieuwe calls kost.
      cached.transcript = transcript;
      if (audioBase64) cached.audioBase64 = audioBase64;
    }

    if (audioBase64 && cached?.imagePath) {
      await saveAudioNextToImage(cached.imagePath, audioBase64);
    }

    // Geen audio? Dan geeft de browser de tekst uit via de Web Speech API.
    res.json({
      transcript,
      audioBase64,
      voice: audioBase64 ? 'elevenlabs' : 'browser',
      reused: false,
    });
  } catch (error) {
    console.error('[speak]', error);
    res.status(500).json({
      error: 'speak_crashed',
      transcript: fallbackLine(),
      voice: 'browser',
    });
  }
});

/* ------------------------------------------------------------------ */

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

app.listen(PORT, () => {
  console.log(`\n  Digibord AI Toverstudio -> http://localhost:${PORT}\n`);
  if (RENDER_ENGINE === 'gemini') {
    console.log(
      `  Tekenmotor    gemini  [${GEMINI_IMAGE_MODEL}]  ` +
        `${GEMINI_API_KEY ? 'sleutel OK' : 'GEEN SLEUTEL'}`,
    );
    console.log('                terugval: RENDER_ENGINE=fal in .env');
  } else {
    console.log(`  Tekenmotor    fal  [${FAL_MODEL}]  ${FAL_KEY ? 'sleutel OK' : 'GEEN SLEUTEL'}`);
    console.log(
      FAL_MODE === 'controlnet'
        ? `  Route         controlnet, tekening leidend op ${FAL_CONTROL_SCALE}`
        : `  Route         img2img, strength ${FAL_STRENGTH}, verzachten ${SOFTEN_GRID}`,
    );
  }
  console.log(`  Stemtekst     ${GEMINI_API_KEY ? 'OK' : 'ONTBREEKT (GEMINI_API_KEY)'}  [${GEMINI_MODEL}]`);
  if (!ELEVENLABS_API_KEY) {
    console.log('  Stem          ONTBREEKT -> browserstem als terugval\n');
  } else if (ELEVENLABS_VOICE_MODE === 'random' && ELEVENLABS_VOICE_POOL.length) {
    console.log(`  Stem          random uit ${ELEVENLABS_VOICE_POOL.length} stemmen\n`);
  } else {
    console.log(`  Stem          per thema (ELEVENLABS_VOICE_MODE=thema)\n`);
  }
  warmUp();
});
