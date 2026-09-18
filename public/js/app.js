/* =====================================================================
   Digibord AI Toverstudio - frontend
   ===================================================================== */
(() => {
  'use strict';

  const EMOJI_FONT =
    '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';

  // Geen automatische render meer: omzetten gebeurt alleen op de toverknop.
  // Dat voorkomt ook dat elke penstreek een betaalde call afvuurt.
  const EXPORT_SIZE = 1024;

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  const state = {
    intentId: window.INTENTS[0].id,
    themeLabel: window.INTENTS[0].label,
    colorWords: '',
    penColor: window.PEN_COLORS[0].value,
    mode: 'move', // 'move' | 'draw'
    dirty: false, // iets veranderd sinds de laatste render?
    renderInFlight: false,
    blocked: null,
    lastRenderId: null,
    lastImageUrl: null,
    frontLayer: 'A',
    speaking: false,
    history: [],
    capabilities: { fal: false, gemini: false, elevenlabs: false },
  };

  const el = (id) => document.getElementById(id);

  const dom = {
    stickerTabs: el('stickerTabs'),
    stickerGrid: el('stickerGrid'),
    swatches: el('swatches'),
    intents: el('intents'),
    colorRow: el('colorRow'),
    btnGear: el('btnGear'),
    gearPanel: el('gearPanel'),
    promptExtra: el('promptExtra'),
    promptSeen: el('promptSeen'),
    buildHint: el('buildHint'),
    canvasWrap: el('canvasWrap'),
    btnMove: el('btnMove'),
    btnDraw: el('btnDraw'),
    btnEraser: el('btnEraser'),
    btnUndo: el('btnUndo'),
    btnReset: el('btnReset'),
    btnMagic: el('btnMagic'),
    childName: el('childName'),
    btnSpeak: el('btnSpeak'),
    result: el('result'),
    resultA: el('resultA'),
    resultB: el('resultB'),
    resultPlaceholder: el('resultPlaceholder'),
    resultSpinner: el('resultSpinner'),
    resultTap: el('resultTap'),
    magicStatus: el('magicStatus'),
    magicHint: el('magicHint'),
    bubble: el('bubble'),
    resetModal: el('resetModal'),
    resetYes: el('resetYes'),
    resetNo: el('resetNo'),
    toast: el('toast'),
  };

  /* ------------------------------------------------------------------ */
  /* Geluidjes (geen assets nodig)                                       */
  /* ------------------------------------------------------------------ */

  let audioCtx = null;

  function blip(frequency = 660, duration = 0.08) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.22, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + duration + 0.02);
    } catch {
      /* geluid is bonus, nooit blokkerend */
    }
  }

  const sfx = {
    tap: () => blip(720, 0.07),
    place: () => blip(880, 0.1),
    poof: () => blip(300, 0.18),
    done: () => {
      blip(680, 0.09);
      setTimeout(() => blip(1020, 0.12), 90);
    },
  };

  /* ------------------------------------------------------------------ */
  /* Canvas                                                              */
  /* ------------------------------------------------------------------ */

  const canvas = new fabric.Canvas('studioCanvas', {
    backgroundColor: '#ffffff',
    preserveObjectStacking: true,
    allowTouchScrolling: false,
    enableRetinaScaling: true,
    selection: false,
  });

  function styleObject(obj) {
    obj.set({
      borderColor: '#7c3aed',
      borderScaleFactor: 3,
      cornerColor: '#ffffff',
      cornerStrokeColor: '#7c3aed',
      cornerStyle: 'circle',
      cornerSize: 40,
      touchCornerSize: 58,
      transparentCorners: false,
      padding: 10,
      centeredScaling: true,
      lockScalingFlip: true,
      objectCaching: false,
    });
    // Alleen een hoek-pin (rechtsonder) + draaiknop: geen verwarrende handvatten.
    obj.setControlsVisibility({
      ml: false,
      mr: false,
      mt: false,
      mb: false,
      tl: false,
      tr: false,
      bl: false,
      br: true,
      mtr: true,
    });
    return obj;
  }

  function fitCanvas() {
    const rect = dom.canvasWrap.getBoundingClientRect();
    const size = Math.max(200, Math.floor(Math.min(rect.width, rect.height)));
    const previous = canvas.getWidth() || size;
    canvas.setDimensions({ width: size, height: size });

    if (previous && Math.abs(previous - size) > 1) {
      const ratio = size / previous;
      canvas.getObjects().forEach((obj) => {
        obj.set({
          left: obj.left * ratio,
          top: obj.top * ratio,
          scaleX: obj.scaleX * ratio,
          scaleY: obj.scaleY * ratio,
        });
        obj.setCoords();
      });
    }
    canvas.requestRenderAll();
  }

  const penBrush = new fabric.PencilBrush(canvas);
  penBrush.color = state.penColor;
  penBrush.width = 16;
  canvas.freeDrawingBrush = penBrush;

  /** In gum-stand mogen stickers niet meeslepen met de vinger. */
  function lockObjects(locked) {
    canvas.getObjects().forEach((obj) => {
      obj.lockMovementX = locked;
      obj.lockMovementY = locked;
      obj.hasControls = !locked;
    });
  }

  const HINTS = {
    move: 'Tik een sticker, sleep hem, dubbeltik om weg te halen',
    draw: 'Teken er vrij bij met de viltstift',
    erase: 'Gum aan: tik op iets om het weg te halen',
  };

  function setMode(mode) {
    state.mode = mode;
    canvas.isDrawingMode = mode === 'draw';
    canvas.defaultCursor = mode === 'erase' ? 'crosshair' : 'default';
    dom.btnMove.classList.toggle('is-active', mode === 'move');
    dom.btnDraw.classList.toggle('is-active', mode === 'draw');
    dom.btnEraser.classList.toggle('is-active', mode === 'erase');
    dom.buildHint.textContent = HINTS[mode] || HINTS.move;
    lockObjects(mode === 'erase');
    if (mode !== 'move') canvas.discardActiveObject();
    canvas.requestRenderAll();
  }

  function setPenColor(color) {
    state.penColor = color;
    penBrush.color = color;
    penBrush.width = 16;
    canvas.freeDrawingBrush = penBrush;
    dom.swatches.querySelectorAll('.swatch').forEach((node) => {
      node.classList.toggle('is-active', node.dataset.color === color);
    });
    setMode('draw');
  }

  /** Gum: tik of veeg over iets en het verdwijnt (sticker of stiftstreek). */
  function useEraser() {
    dom.swatches.querySelectorAll('.swatch').forEach((n) => n.classList.remove('is-active'));
    setMode('erase');
  }

  let erasing = false;

  function eraseAt(options) {
    const target = options.target || canvas.findTarget(options.e, true);
    if (target && !target.__removing) removeObject(target);
  }

  canvas.on('mouse:down', (options) => {
    if (state.mode !== 'erase') return;
    erasing = true;
    eraseAt(options);
  });
  canvas.on('mouse:move', (options) => {
    if (state.mode === 'erase' && erasing) eraseAt(options);
  });
  canvas.on('mouse:up', () => {
    erasing = false;
  });

  /** Voegt een sticker toe in het midden van het canvas (met kleine spreiding). */
  function addSticker(sticker) {
    const size = canvas.getWidth();
    const scale = size / 900; // definities zijn op een 900px canvas ontworpen
    const jitter = () => (Math.random() - 0.5) * size * 0.16;

    const place = (obj) => {
      styleObject(obj);
      obj.set({
        left: size / 2 + jitter(),
        top: size / 2 + jitter(),
        originX: 'center',
        originY: 'center',
      });
      canvas.add(obj);
      canvas.setActiveObject(obj);
      state.history.push(obj);
      canvas.requestRenderAll();
      sfx.place();
      popIn(obj);
      markDirty();
    };

    if (sticker.src) {
      fabric.Image.fromURL(
        sticker.src,
        (img) => {
          if (!img) return;
          const target = (sticker.size || 160) * scale;
          img.scaleToWidth(target);
          place(img);
        },
        { crossOrigin: 'anonymous' },
      );
      return;
    }

    const text = new fabric.Text(sticker.emoji, {
      fontSize: Math.round((sticker.size || 150) * scale),
      fontFamily: EMOJI_FONT,
      selectable: true,
    });
    place(text);
  }

  /** Klein 'plop' animatietje bij het plaatsen. */
  function popIn(obj) {
    const targetX = obj.scaleX;
    const targetY = obj.scaleY;
    obj.set({ scaleX: targetX * 0.4, scaleY: targetY * 0.4 });
    obj.animate(
      { scaleX: targetX, scaleY: targetY },
      {
        duration: 260,
        easing: fabric.util.ease.easeOutBack,
        onChange: () => canvas.requestRenderAll(),
      },
    );
  }

  function removeObject(obj) {
    if (!obj || obj.__removing) return;
    obj.__removing = true;
    obj.selectable = false;
    obj.evented = false;
    sfx.poof();
    obj.animate(
      { opacity: 0, scaleX: obj.scaleX * 1.4, scaleY: obj.scaleY * 1.4 },
      {
        duration: 180,
        onChange: () => canvas.requestRenderAll(),
        onComplete: () => {
          canvas.remove(obj);
          state.history = state.history.filter((item) => item !== obj);
          canvas.requestRenderAll();
          markDirty();
        },
      },
    );
  }

  function undo() {
    const objects = canvas.getObjects();
    const last = objects[objects.length - 1];
    if (!last) return;
    removeObject(last);
  }

  function clearAll() {
    canvas.getObjects().slice().forEach((obj) => canvas.remove(obj));
    state.history = [];
    canvas.backgroundColor = '#ffffff';
    canvas.requestRenderAll();
    state.lastRenderId = null;
    state.lastImageUrl = null;
    state.dirty = false;
    state.blocked = null;
    // Naam ook wissen: het volgende kind moet niet onder een andere naam
    // terechtkomen in de bestandsnamen en het verhaaltje.
    dom.childName.value = '';
    updateMagicButton();
    hideResult();
    setMagicStatus('Klaar om te toveren');
    dom.magicHint.textContent = 'Maak iets en tik dan op de toverknop!';
    dom.btnSpeak.disabled = true;
    dom.bubble.hidden = true;
  }

  /* Canvas events -> knop laten pulseren, niet zelf renderen */
  canvas.on('object:added', markDirty);
  canvas.on('object:modified', markDirty);
  canvas.on('path:created', () => {
    const paths = canvas.getObjects();
    const last = paths[paths.length - 1];
    if (last) styleObject(last);
    markDirty();
  });
  canvas.on('mouse:dblclick', (event) => {
    if (event.target) removeObject(event.target);
  });

  /* ------------------------------------------------------------------ */
  /* UI opbouw                                                           */
  /* ------------------------------------------------------------------ */

  function buildStickerDock() {
    window.STICKER_TABS.forEach((tab, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dock__tab' + (index === 0 ? ' is-active' : '');
      button.textContent = tab.label;
      button.dataset.tab = tab.id;
      button.setAttribute('role', 'tab');
      button.addEventListener('click', () => {
        sfx.tap();
        dom.stickerTabs.querySelectorAll('.dock__tab').forEach((n) => n.classList.remove('is-active'));
        button.classList.add('is-active');
        renderStickerGrid(tab);
      });
      dom.stickerTabs.appendChild(button);
    });
    renderStickerGrid(window.STICKER_TABS[0]);
  }

  function renderStickerGrid(tab) {
    dom.stickerGrid.innerHTML = '';
    tab.stickers.forEach((sticker) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sticker';
      button.title = sticker.name;
      button.setAttribute('aria-label', sticker.name);
      button.innerHTML = sticker.src
        ? `<img src="${sticker.src}" alt="${sticker.name}" />`
        : `<span class="sticker__emoji">${sticker.emoji}</span>`;
      button.addEventListener('click', () => {
        sfx.tap();
        setMode('move');
        addSticker(sticker);
      });
      dom.stickerGrid.appendChild(button);
    });
  }

  function buildSwatches() {
    window.PEN_COLORS.forEach((color, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch' + (index === 0 ? ' is-active' : '');
      button.style.background = color.value;
      button.dataset.color = color.value;
      button.title = color.name;
      button.setAttribute('aria-label', `Stift ${color.name}`);
      button.addEventListener('click', () => {
        sfx.tap();
        setPenColor(color.value);
      });
      dom.swatches.appendChild(button);
    });
  }

  function buildIntents() {
    window.INTENTS.forEach((intent, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'intent' + (index === 0 ? ' is-active' : '');
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', index === 0 ? 'true' : 'false');
      button.innerHTML = `<span class="intent__icon">${intent.icon}</span><span class="intent__label">${intent.label}</span>`;
      button.addEventListener('click', () => {
        sfx.tap();
        state.intentId = intent.id;
        state.themeLabel = intent.label;
        dom.intents.querySelectorAll('.intent').forEach((node) => {
          node.classList.remove('is-active');
          node.setAttribute('aria-checked', 'false');
        });
        button.classList.add('is-active');
        button.setAttribute('aria-checked', 'true');
        dom.magicHint.textContent = `Jij maakt een ${intent.label.toLowerCase()}!`;
        markDirty();
      });
      dom.intents.appendChild(button);
    });
  }

  function buildColorPicker() {
    window.CREATURE_COLORS.forEach((color, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'colorpick__dot' + (index === 0 ? ' is-active' : '');
      button.style.background = color.swatch;
      button.title = color.label;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', `Kleur ${color.label}`);
      button.setAttribute('aria-checked', index === 0 ? 'true' : 'false');
      button.addEventListener('click', () => {
        sfx.tap();
        state.colorWords = color.words;
        dom.colorRow.querySelectorAll('.colorpick__dot').forEach((node) => {
          node.classList.remove('is-active');
          node.setAttribute('aria-checked', 'false');
        });
        button.classList.add('is-active');
        button.setAttribute('aria-checked', 'true');
        markDirty();
      });
      dom.colorRow.appendChild(button);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Render pipeline                                                     */
  /* ------------------------------------------------------------------ */

  function setMagicStatus(text) {
    dom.magicStatus.textContent = text;
  }

  function showSpinner(visible) {
    dom.resultSpinner.classList.toggle('is-visible', visible);
  }

  function hideResult() {
    dom.resultA.classList.remove('is-front');
    dom.resultB.classList.remove('is-front');
    dom.resultA.removeAttribute('src');
    dom.resultB.removeAttribute('src');
    dom.resultPlaceholder.hidden = false;
    dom.resultTap.classList.remove('is-visible');
    showSpinner(false);
  }

  /**
   * Er is iets veranderd op het canvas of aan de keuzes. We renderen niet
   * zelf: we laten de toverknop pulseren zodat het kind hem aantikt.
   */
  function markDirty() {
    state.dirty = true;
    updateMagicButton();
  }

  function updateMagicButton() {
    const hasDrawing = canvas.getObjects().length > 0;
    const busy = state.renderInFlight;

    dom.btnMagic.disabled = busy || !hasDrawing || !state.capabilities.fal;
    dom.btnMagic.classList.toggle('is-busy', busy);
    dom.btnMagic.classList.toggle('is-ready', !busy && hasDrawing && state.dirty);
  }

  /** Start de omzetting. Alleen vanaf de toverknop. */
  function startRender() {
    if (state.renderInFlight) return;
    if (canvas.getObjects().length === 0) {
      setMagicStatus('✏️ Maak eerst iets op het canvas');
      return;
    }
    if (!state.capabilities.fal) {
      setMagicStatus('🔑 Geen sleutel: vul .env in om te toveren');
      return;
    }

    // Een blokkerende fout hoeft niet meer apart weggetikt: de knop is de
    // bewuste actie van de gebruiker, dus we proberen het gewoon.
    state.blocked = null;
    dom.magicStatus.classList.remove('is-retry');

    executeLiveRender();
  }

  /**
   * Exporteert het canvas als JPEG van EXPORT_SIZE x EXPORT_SIZE.
   *
   * We tekenen bewust eerst een witte rechthoek en zetten het canvas daar
   * bovenop. Fabric's achtergrondkleur gaat verloren zodra je toDataURL met
   * een multiplier gebruikt, en JPEG kent geen transparantie: die twee samen
   * leveren een volledig zwarte afbeelding op. Zwart in -> zwart uit.
   */
  function exportCanvas() {
    const width = canvas.getWidth() || EXPORT_SIZE;
    const source = canvas.toCanvasElement(EXPORT_SIZE / width, {
      enableRetinaScaling: false,
    });

    const flat = document.createElement('canvas');
    flat.width = EXPORT_SIZE;
    flat.height = EXPORT_SIZE;

    const ctx = flat.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, EXPORT_SIZE, EXPORT_SIZE);
    ctx.drawImage(source, 0, 0, EXPORT_SIZE, EXPORT_SIZE);

    return flat.toDataURL('image/jpeg', 0.85);
  }

  async function executeLiveRender() {
    if (state.renderInFlight) return;

    state.renderInFlight = true;
    state.dirty = false;
    updateMagicButton();
    showSpinner(true);
    setMagicStatus('✨ Toverstof strooien...');

    try {
      const response = await fetch('/api/render-live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: exportCanvas(),
          intentId: state.intentId,
          colors: state.colorWords,
          extra: dom.promptExtra.value.trim(),
          childName: dom.childName.value.trim(),
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.imageUrl) {
        // Het vorige beeld blijft staan. Opnieuw proberen doet de gebruiker
        // zelf met de toverknop, dus we vuren nooit ongevraagd een call af.
        const message = payload.message || 'Even niet gelukt';
        state.blocked = payload.blocking ? message : null;
        setMagicStatus(`${payload.blocking ? '⚠️' : '😴'} ${message}`);
        dom.magicStatus.classList.toggle('is-retry', Boolean(payload.blocking));
        toast(message);
        state.dirty = true;
        return;
      }

      state.blocked = null;
      dom.magicStatus.classList.remove('is-retry');
      if (payload.prompt) dom.promptSeen.value = payload.prompt;

      await crossFadeTo(payload.imageUrl);
      state.lastRenderId = payload.renderId || null;
      state.lastImageUrl = payload.imageUrl;
      dom.btnSpeak.disabled = false;
      dom.resultTap.classList.add('is-visible');
      setMagicStatus(`✨ Jouw ${state.themeLabel.toLowerCase()} is wakker!`);
      sfx.done();
    } catch (error) {
      console.error(error);
      setMagicStatus('😴 De tovenaar slaapt even');
      toast('Geen verbinding met de toverstudio');
      state.dirty = true;
    } finally {
      state.renderInFlight = false;
      showSpinner(false);
      updateMagicButton();
    }
  }

  /** Vloeiende cross-fade tussen twee gerenderde beelden. */
  function crossFadeTo(url) {
    return new Promise((resolve) => {
      const incoming = state.frontLayer === 'A' ? dom.resultB : dom.resultA;
      const outgoing = state.frontLayer === 'A' ? dom.resultA : dom.resultB;

      const reveal = () => {
        dom.resultPlaceholder.hidden = true;
        incoming.classList.add('is-front');
        outgoing.classList.remove('is-front');
        state.frontLayer = state.frontLayer === 'A' ? 'B' : 'A';
        resolve();
      };

      incoming.onload = reveal;
      incoming.onerror = () => resolve();
      incoming.src = url;
      if (incoming.complete && incoming.naturalWidth) reveal();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Spreken                                                             */
  /* ------------------------------------------------------------------ */

  async function speak() {
    if (state.speaking || !state.lastImageUrl) return;
    state.speaking = true;
    dom.btnSpeak.disabled = true;
    dom.btnSpeak.classList.add('is-busy');
    setMagicStatus('🎤 Even nadenken...');

    try {
      const response = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          renderId: state.lastRenderId,
          imageUrl: state.lastRenderId ? undefined : state.lastImageUrl,
          theme: state.themeLabel,
          intentId: state.intentId,
          childName: dom.childName.value.trim(),
        }),
      });

      const payload = await response.json().catch(() => ({}));
      const transcript = payload.transcript || 'Hoi! Ik ben een geheim wezen!';

      showBubble(transcript);
      setMagicStatus('🔊 Luister!');

      if (payload.audioBase64) {
        await playAudio(`data:audio/mpeg;base64,${payload.audioBase64}`);
      } else {
        browserSpeak(transcript);
      }
    } catch (error) {
      console.error(error);
      toast('Kon niet praten, probeer opnieuw');
    } finally {
      state.speaking = false;
      dom.btnSpeak.disabled = false;
      dom.btnSpeak.classList.remove('is-busy');
    }
  }

  function playAudio(src) {
    return new Promise((resolve) => {
      const audio = new Audio(src);
      audio.onended = resolve;
      audio.onerror = resolve;
      audio.play().catch(resolve);
    });
  }

  /** Terugval als ElevenLabs niet beschikbaar is. */
  function browserSpeak(text) {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'nl-NL';
    utterance.pitch = 1.6;
    utterance.rate = 1.02;
    const dutch = speechSynthesis.getVoices().find((voice) => voice.lang.startsWith('nl'));
    if (dutch) utterance.voice = dutch;
    speechSynthesis.cancel();
    speechSynthesis.speak(utterance);
  }

  function showBubble(text) {
    dom.bubble.textContent = text;
    dom.bubble.hidden = false;
    dom.bubble.classList.remove('is-pop');
    void dom.bubble.offsetWidth;
    dom.bubble.classList.add('is-pop');
  }

  /* ------------------------------------------------------------------ */
  /* Toast                                                               */
  /* ------------------------------------------------------------------ */

  let toastTimer = null;
  function toast(message) {
    dom.toast.textContent = message;
    dom.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      dom.toast.hidden = true;
    }, 3200);
  }

  /* ------------------------------------------------------------------ */
  /* Events                                                              */
  /* ------------------------------------------------------------------ */

  dom.btnMove.addEventListener('click', () => {
    sfx.tap();
    setMode('move');
  });
  dom.btnDraw.addEventListener('click', () => {
    sfx.tap();
    setPenColor(state.penColor);
  });
  dom.btnEraser.addEventListener('click', () => {
    sfx.tap();
    useEraser();
  });
  dom.btnUndo.addEventListener('click', () => {
    sfx.tap();
    undo();
  });

  dom.btnReset.addEventListener('click', () => {
    sfx.tap();
    dom.resetModal.hidden = false;
  });
  dom.resetNo.addEventListener('click', () => {
    sfx.tap();
    dom.resetModal.hidden = true;
  });
  dom.resetYes.addEventListener('click', () => {
    sfx.poof();
    dom.resetModal.hidden = true;
    dom.canvasWrap.classList.add('is-wiped');
    setTimeout(() => dom.canvasWrap.classList.remove('is-wiped'), 600);
    clearAll();
  });

  dom.btnGear.addEventListener('click', () => {
    sfx.tap();
    dom.gearPanel.hidden = !dom.gearPanel.hidden;
  });

  dom.promptExtra.addEventListener('input', markDirty);

  dom.btnMagic.addEventListener('click', () => {
    sfx.tap();
    startRender();
  });

  dom.btnSpeak.addEventListener('click', () => {
    sfx.tap();
    speak();
  });
  dom.result.addEventListener('click', () => {
    if (state.lastImageUrl) {
      sfx.tap();
      speak();
    }
  });

  window.addEventListener('resize', () => {
    clearTimeout(window.__fitTimer);
    window.__fitTimer = setTimeout(fitCanvas, 120);
  });

  // Digibord: geen contextmenu, geen pinch-zoom van de pagina.
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener(
    'gesturestart',
    (event) => event.preventDefault(),
    { passive: false },
  );
  document.addEventListener(
    'touchmove',
    (event) => {
      if (event.touches.length > 1) event.preventDefault();
    },
    { passive: false },
  );

  /* ------------------------------------------------------------------ */
  /* Init                                                                */
  /* ------------------------------------------------------------------ */

  async function loadCapabilities() {
    try {
      const response = await fetch('/api/health');
      const payload = await response.json();
      state.capabilities = {
        fal: Boolean(payload.canRender),
        gemini: Boolean(payload.gemini),
        elevenlabs: Boolean(payload.elevenlabs),
      };
      if (!payload.canRender) {
        setMagicStatus(
          payload.engine === 'gemini'
            ? '🔑 Geen Gemini-sleutel gevonden'
            : '🔑 Zet FAL_KEY in .env om te kunnen toveren',
        );
      }
      updateMagicButton();
    } catch {
      setMagicStatus('🔌 Server niet bereikbaar');
      updateMagicButton();
    }
  }

  function init() {
    buildStickerDock();
    buildSwatches();
    buildIntents();
    buildColorPicker();
    fitCanvas();
    setMode('move');
    updateMagicButton();
    dom.magicHint.textContent = `Jij maakt een ${state.themeLabel.toLowerCase()}!`;
    loadCapabilities();

    if ('speechSynthesis' in window) speechSynthesis.getVoices();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
