/**
 * Sticker- en themadefinities voor de Toverstudio.
 *
 * Stickers zijn Unicode-emoji: geen assets nodig, scherp op elke resolutie en
 * direct herkenbaar voor kinderen van 6. Wil je PNG-assets gebruiken, zet dan
 * `src: 'img/vleugels.png'` op een sticker; app.js laadt die dan als afbeelding.
 */
window.STICKER_TABS = [
  {
    id: 'gezicht',
    label: '😊 Gezicht',
    stickers: [
      { emoji: '👀', name: 'Ogen', size: 150 },
      { emoji: '😉', name: 'Knipoog', size: 150 },
      { emoji: '👁️', name: 'Groot oog', size: 130 },
      { emoji: '🫥', name: 'Drakenogen', size: 150 },
      { emoji: '👄', name: 'Mond', size: 130 },
      { emoji: '😬', name: 'Tanden', size: 150 },
      { emoji: '🦷', name: 'Vampiertand', size: 110 },
      { emoji: '😁', name: 'Grote glimlach', size: 160 },
      { emoji: '👃', name: 'Neus', size: 120 },
      { emoji: '👂', name: 'Oor', size: 120 },
      { emoji: '🥸', name: 'Snor', size: 150 },
      { emoji: '👅', name: 'Tong', size: 120 },
    ],
  },
  {
    id: 'attributen',
    label: '👑 Attributen',
    stickers: [
      { emoji: '🪽', name: 'Vleugels', size: 190 },
      { emoji: '🦋', name: 'Feeënvleugels', size: 170 },
      { emoji: '👑', name: 'Kroontje', size: 160 },
      { emoji: '🪖', name: 'Ridderhelm', size: 170 },
      { emoji: '🎩', name: 'Hoge hoed', size: 160 },
      { emoji: '🥳', name: 'Feesthoedje', size: 160 },
      { emoji: '🦄', name: 'Hoorn', size: 170 },
      { emoji: '🪄', name: 'Toverstaf', size: 150 },
      { emoji: '🛡️', name: 'Schild', size: 160 },
      { emoji: '⚔️', name: 'Zwaard', size: 160 },
      { emoji: '🧣', name: 'Sjaal', size: 150 },
      { emoji: '🥾', name: 'Laarzen', size: 150 },
    ],
  },
  {
    id: 'omgeving',
    label: '🏰 Wereld',
    stickers: [
      { emoji: '🏰', name: 'Kasteel', size: 200 },
      { emoji: '🗼', name: 'Torentje', size: 180 },
      { emoji: '☁️', name: 'Wolk', size: 180 },
      { emoji: '🌈', name: 'Regenboog', size: 190 },
      { emoji: '🍄', name: 'Paddenstoel', size: 160 },
      { emoji: '🌳', name: 'Boom', size: 180 },
      { emoji: '🌻', name: 'Bloem', size: 150 },
      { emoji: '⭐', name: 'Sterretje', size: 130 },
      { emoji: '🌙', name: 'Maan', size: 150 },
      { emoji: '🔥', name: 'Vuur', size: 150 },
      { emoji: '🪐', name: 'Planeet', size: 170 },
      { emoji: '🚀', name: 'Raket', size: 170 },
    ],
  },
  {
    id: 'lijf',
    label: '🐾 Lijf',
    stickers: [
      { emoji: '🫧', name: 'Rond lijf', size: 220 },
      { emoji: '🟢', name: 'Groene bol', size: 200 },
      { emoji: '🟣', name: 'Paarse bol', size: 200 },
      { emoji: '🩷', name: 'Roze hart', size: 190 },
      { emoji: '🐾', name: 'Pootjes', size: 160 },
      { emoji: '🦶', name: 'Voet', size: 150 },
      { emoji: '🤚', name: 'Hand', size: 150 },
      { emoji: '🦎', name: 'Staart', size: 170 },
      { emoji: '🌀', name: 'Krulstaart', size: 160 },
      { emoji: '🫟', name: 'Spetter', size: 170 },
      { emoji: '💜', name: 'Hartje', size: 150 },
      { emoji: '✨', name: 'Glitter', size: 150 },
    ],
  },
];

/**
 * Kleur van het beestje. Belangrijk: in controlnet-modus gebruikt het model
 * alleen de lijnen van de tekening, niet de kleuren. De kleur moet dus hier
 * vandaan komen, anders kiest het model er zelf een (en dat werd altijd roze).
 */
window.CREATURE_COLORS = [
  { label: 'Verrassing', swatch: 'conic-gradient(#ff2d55,#ffd60a,#34c759,#0a84ff,#af52de,#ff2d55)', words: '' },
  { label: 'Roze', swatch: '#ff69b4', words: 'pink' },
  { label: 'Rood', swatch: '#ff2d55', words: 'red' },
  { label: 'Oranje', swatch: '#ff9500', words: 'orange' },
  { label: 'Geel', swatch: '#ffd60a', words: 'yellow' },
  { label: 'Groen', swatch: '#34c759', words: 'green' },
  { label: 'Blauw', swatch: '#0a84ff', words: 'blue' },
  { label: 'Paars', swatch: '#af52de', words: 'purple' },
  { label: 'Bruin', swatch: '#a2845e', words: 'brown' },
  { label: 'Regenboog', swatch: 'linear-gradient(135deg,#ff2d55,#ffd60a,#34c759,#0a84ff,#af52de)', words: 'rainbow multicolored' },
];

/**
 * Intentiebalk. Alleen id, pictogram en label: de bijbehorende prompt staat in
 * server.js onder THEME_PROMPTS.
 *
 * Waarom daar: de eigenschappen horen bij het thema. Toen ze in de basisprompt
 * stonden kreeg een getekende raket ook "fluffy fur" en "tiny paws" mee.
 */
window.INTENTS = [
  { id: 'draak', icon: '🐉', label: 'Draak' },
  { id: 'fee', icon: '🧚', label: 'Fee' },
  { id: 'ridder', icon: '🏰', label: 'Ridder' },
  { id: 'monster', icon: '👾', label: 'Monster' },
  { id: 'ruimte', icon: '🚀', label: 'Ruimte' },
];

/** Stiftkleuren. */
window.PEN_COLORS = [
  { name: 'Rood', value: '#ff2d55' },
  { name: 'Oranje', value: '#ff9500' },
  { name: 'Geel', value: '#ffd60a' },
  { name: 'Groen', value: '#34c759' },
  { name: 'Blauw', value: '#0a84ff' },
  { name: 'Paars', value: '#af52de' },
  { name: 'Zwart', value: '#1c1c1e' },
];
