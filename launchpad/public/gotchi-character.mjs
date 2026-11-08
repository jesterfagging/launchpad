// Animated Gotchi characters. The characters in public/gotchi-catalog.mjs
// (Fomogotchi, Pumpgotchi), each with three evolution stages drawn as separate layered PNG
// rigs, share one controller: idle breathing, blinking and gestures run as CSS
// animations; touch, petting, treats, expressions, evolution and celebration
// are driven here. Every rig is sized by the height of its drawn figure, so the
// characters and their stages render at the same size. Everything pauses
// offscreen and respects prefers-reduced-motion. No network, storage or wallet access.
import { gotchiTheme } from './gotchi-catalog.mjs';

const SVG = 'http://www.w3.org/2000/svg';
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const EXPRESSIONS = new Set(['neutral', 'happy', 'surprised', 'sleepy', 'love', 'dizzy', 'wink', 'squint']);
let styleCounter = 0;

function pct(value, total) { return (value / total * 100).toFixed(3) + '%'; }

export function createGotchiCharacter({ document, window = document.defaultView, theme, stage = 1, size = 'card', interactive = true, clock = Date.now, random = Math.random } = {}) {
  const spec = typeof theme === 'string' ? gotchiTheme(theme) : theme;
  if (!spec) throw Error('Unknown Gotchi theme.');
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const svg = (tag, attributes = {}) => { const node = document.createElementNS(SVG, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); return node; };
  if (!document.getElementById('gotchi-character-styles')) { const link = document.createElement('link'); link.id = 'gotchi-character-styles'; link.rel = 'stylesheet'; link.href = '/gotchi-character.css'; document.head.append(link); }
  const motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const reduced = () => motionQuery?.matches === true;
  // Every evolution stage is its own layered artwork (public/gotchi-catalog.mjs
  // `stages`); older catalogues with a single `rig` use it for all three.
  const stageRig = n => spec.stages?.[clamp(Number(n) || 1, 1, 3) - 1] || spec.rig;
  const root = el('div', 'gotchi-character'); root.dataset.theme = spec.id; root.dataset.size = size; root.dataset.stage = String(clamp(Number(stage) || 1, 1, 3)); root.dataset.mood = 'idle'; root.dataset.interaction = spec.interaction; root.setAttribute('role', 'img'); root.setAttribute('aria-label', `${spec.name}, ${spec.evolutions[Number(root.dataset.stage) - 1].title}`); root.id = 'gotchi-character-' + (++styleCounter);
  for (const [key, value] of Object.entries(spec.palette)) root.style.setProperty('--gotchi-' + key.replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value);
  const aura = el('div', 'gotchi-aura'), fx = el('div', 'gotchi-fx'), rig = el('div', 'gotchi-rig'); fx.setAttribute('aria-hidden', 'true'); aura.setAttribute('aria-hidden', 'true');
  // The element's width follows the figure's height (ears or antennae to feet),
  // not the canvas, and stages align the feet to one baseline. Each stage's
  // artwork has its own canvas, so the metrics are reapplied on evolution.
  function applyMetrics(pose) {
    const [canvasW, canvasH] = pose.canvas, [figureTop, figureBottom] = pose.figure || [0, canvasH];
    rig.style.aspectRatio = `${canvasW} / ${canvasH}`;
    root.style.setProperty('--gotchi-figure-ratio', (canvasW / Math.max(1, figureBottom - figureTop)).toFixed(4));
    root.style.setProperty('--gotchi-figure-bottom', ((canvasH - figureBottom) / canvasH * 100).toFixed(3));
    root.style.setProperty('--gotchi-figure-top', (figureTop / canvasH * 100).toFixed(3));
  }
  const poses = new Map(), timers = new Set(); let disposed = false, live = false, paused = false, blinkTimer = null, gestureTimer = null, expression = 'neutral', expressionTimer = null, petting = false, lastPointer = null, petHearts = 0, treats = 0, observer = null, lastLook = { x: 0, y: 0 };
  const later = (fn, ms) => { const id = window.setTimeout(() => { timers.delete(id); if (!disposed) fn(); }, ms); timers.add(id); return id; };
  const cancel = id => { if (id !== null && id !== undefined) { window.clearTimeout(id); timers.delete(id); } };
  const current = () => stageRig(root.dataset.stage);

  function placeLayer(pose, layer, parent, parentBox) {
    const [canvasW, canvasH] = pose.spec.canvas;
    const [x0, y0, x1, y1] = layer.box, [px0, py0, px1, py1] = parentBox || [0, 0, canvasW, canvasH], pw = px1 - px0, ph = py1 - py0;
    const wrap = el('div', 'gotchi-layer gotchi-layer-' + layer.name), anim = el('div', 'gotchi-anim');
    if (layer.name.startsWith('tail')) { wrap.classList.add('gotchi-layer-tail', 'gotchi-tail'); if (layer.mirror) wrap.classList.add('gotchi-tail-mirror'); }
    wrap.style.left = pct(x0 - px0, pw); wrap.style.top = pct(y0 - py0, ph); wrap.style.width = pct(x1 - x0, pw); wrap.style.height = pct(y1 - y0, ph);
    const [pvx, pvy] = layer.pivot; wrap.style.transformOrigin = `${pct(pvx - x0, x1 - x0)} ${pct(pvy - y0, y1 - y0)}`; anim.style.transformOrigin = wrap.style.transformOrigin;
    const img = document.createElement('img'); img.src = '/gotchi/' + layer.file; img.alt = ''; img.draggable = false; img.decoding = 'async'; img.loading = size === 'mini' ? 'lazy' : 'eager';
    anim.append(img); wrap.append(anim); (parent || pose.element).append(wrap); pose.layers[layer.name] = wrap; return wrap;
  }
  // An overlay element positioned in canvas coordinates inside a layer box.
  function overlay(cls, box, parent, parentBox) {
    const [x0, y0, x1, y1] = box, [px0, py0, px1, py1] = parentBox, node = el('div', cls);
    node.style.left = pct(x0 - px0, px1 - px0); node.style.top = pct(y0 - py0, py1 - py0); node.style.width = pct(x1 - x0, px1 - px0); node.style.height = pct(y1 - y0, py1 - py0);
    parent.append(node); return node;
  }
  // Tails (one or two, mirrored ones wag in counter-phase), body, head and the
  // eye layer inside the head, plus a field of sparkles shown at stage 3.
  function buildFurry(pose) {
    const layers = pose.spec.layers, head = layers.find(layer => layer.name === 'head'), eyes = layers.find(layer => layer.name === 'eyes');
    let headLayer = null, bodyLayer = null;
    for (const layer of layers) {
      if (layer.name === 'eyes') continue;
      const placed = placeLayer(pose, layer);
      if (layer.name === 'head') headLayer = placed; else if (layer.name === 'body') bodyLayer = placed;
    }
    if (eyes && headLayer) { const eyeLayer = placeLayer(pose, eyes, headLayer.firstChild, head.box); eyeLayer.classList.add('gotchi-eyes'); }
    const sparkles = el('div', 'gotchi-sparkles'); for (let i = 0; i < 7; i++) { const star = el('i'); star.style.setProperty('--i', String(i)); sparkles.append(star); } pose.element.append(sparkles);
    return { bodyLayer, headLayer };
  }
  function visorEye(pose, side) {
    const box = pose.spec.eyes[side], cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const group = svg('g', { class: 'gotchi-visor-eye gotchi-visor-eye-' + side });
    const slit = svg('ellipse', { class: 'gotchi-eye-slit', cx, cy, rx: (box[2] - box[0]) / 2, ry: (box[3] - box[1]) / 2 });
    const happy = svg('path', { class: 'gotchi-eye-happy', d: `M ${cx - 46} ${cy + 18} Q ${cx} ${cy - 70} ${cx + 46} ${cy + 18}` });
    const dizzy = svg('path', { class: 'gotchi-eye-dizzy', d: `M ${cx} ${cy} m -4 0 a 4 4 0 1 1 8 0 a 12 12 0 1 1 -24 0 a 22 22 0 1 1 44 0 a 34 34 0 1 1 -68 0` });
    const love = svg('path', { class: 'gotchi-eye-love', d: `M ${cx} ${cy + 34} C ${cx - 70} ${cy - 20} ${cx - 34} ${cy - 70} ${cx} ${cy - 30} C ${cx + 34} ${cy - 70} ${cx + 70} ${cy - 20} ${cx} ${cy + 34} Z` });
    group.append(slit, happy, dizzy, love); return group;
  }
  // A robot character (interaction 'touch'): arrows behind, body, then the head carrying a live SVG visor
  // (eye slits, expressions and a scan line) sized to that stage's head box.
  function buildVisorBot(pose) {
    let headLayer = null, head = null;
    for (const layer of pose.spec.layers) { const placed = placeLayer(pose, layer); if (layer.name === 'head') { headLayer = placed; head = layer; } }
    if (!headLayer) return;
    const [hx0, hy0, hx1, hy1] = head.box;
    const face = svg('svg', { class: 'gotchi-visor', viewBox: `${hx0} ${hy0} ${hx1 - hx0} ${hy1 - hy0}`, 'aria-hidden': 'true' });
    const eyesGroup = svg('g', { class: 'gotchi-eyes' });
    for (const side of ['left', 'right']) eyesGroup.append(visorEye(pose, side));
    const scan = svg('rect', { class: 'gotchi-visor-scan', x: hx0 + Math.round((hx1 - hx0) * 0.24), y: hy0 + Math.round((hy1 - hy0) * 0.3), width: Math.round((hx1 - hx0) * 0.52), height: 6, rx: 3 });
    face.append(scan, eyesGroup); headLayer.firstChild.append(face);
  }
  // The chevron cat: a furry rig plus a glowing crest and capsule charm that
  // light up from stage 2 wherever that stage's artwork places them.
  function buildPumpgotchi(pose) {
    const { bodyLayer, headLayer } = buildFurry(pose), spec = pose.spec, head = spec.layers.find(layer => layer.name === 'head'), body = spec.layers.find(layer => layer.name === 'body');
    if (spec.crest && headLayer) overlay('gotchi-crest', spec.crest, headLayer.firstChild, head.box);
    if (spec.charm && bodyLayer) overlay('gotchi-charm', spec.charm, bodyLayer.firstChild, body.box);
  }
  function buildPose(n) {
    const key = String(clamp(Number(n) || 1, 1, 3));
    if (poses.has(key)) return poses.get(key);
    const pose = { spec: stageRig(key), element: el('div', 'gotchi-pose'), layers: {} }; pose.element.dataset.poseStage = key;
    if (spec.interaction === 'touch') buildVisorBot(pose); else if (spec.id === 'pumpgotchi') buildPumpgotchi(pose); else buildFurry(pose);
    poses.set(key, pose); rig.append(pose.element); return pose;
  }
  applyMetrics(current()); buildPose(root.dataset.stage);
  root.append(aura, rig, fx);

  function setExpression(next, { hold = 0 } = {}) {
    if (!EXPRESSIONS.has(next)) next = 'neutral';
    expression = next; root.dataset.expression = next; cancel(expressionTimer); expressionTimer = null;
    if (hold > 0) expressionTimer = later(() => { if (expression === next) setExpression('neutral'); }, hold);
  }
  function blinkOnce() { if (disposed || root.dataset.expression === 'sleepy') return; root.classList.add('is-blinking'); later(() => root.classList.remove('is-blinking'), 140); if (random() < 0.18) later(() => { root.classList.add('is-blinking'); later(() => root.classList.remove('is-blinking'), 120); }, 260); }
  function scheduleBlink() { cancel(blinkTimer); if (!live || paused) return; blinkTimer = later(() => { blinkOnce(); scheduleBlink(); }, 2200 + random() * 4200); }
  const gestures = ['tilt-left', 'tilt-right', 'look-around', 'ear-twitch', 'hop', 'wiggle'];
  function gesture(kind) { if (disposed || reduced()) return; root.dataset.gesture = kind; later(() => { if (root.dataset.gesture === kind) delete root.dataset.gesture; }, kind === 'look-around' ? 1800 : 900); }
  function scheduleGesture() { cancel(gestureTimer); if (!live || paused || reduced()) return; gestureTimer = later(() => { if (!petting && root.dataset.mood === 'idle') gesture(gestures[Math.floor(random() * gestures.length)]); scheduleGesture(); }, 6000 + random() * 9000); }
  function spawn(cls, { x = 50, y = 50, text = '', life = 1200 } = {}) {
    if (disposed || reduced() || fx.childElementCount > 40) return null;
    const node = el('span', 'gotchi-particle ' + cls, text || null); node.style.left = x + '%'; node.style.top = y + '%'; node.style.setProperty('--seed', random().toFixed(3)); fx.append(node); later(() => node.remove(), life); return node;
  }
  function look(x, y) {
    const dx = clamp(x, -1, 1), dy = clamp(y, -1, 1); lastLook = { x: dx, y: dy };
    root.style.setProperty('--look-x', dx.toFixed(3)); root.style.setProperty('--look-y', dy.toFixed(3)); root.style.setProperty('--tilt', (dx * (spec.interaction === 'touch' ? 4 : 7)).toFixed(2) + 'deg');
  }
  function relax() { look(0, 0); root.classList.remove('is-tracking'); }
  function pointerVector(event) { const box = rig.getBoundingClientRect(); if (!box.width || !box.height) return { x: 0, y: 0, inside: false }; const x = (event.clientX - box.left) / box.width * 2 - 1, y = (event.clientY - box.top) / box.height * 2 - 1; return { x, y, inside: x >= -1.1 && x <= 1.1 && y >= -1.1 && y <= 1.1 }; }
  function setMood(mood, ms) { root.dataset.mood = mood; if (ms) later(() => { if (root.dataset.mood === mood) root.dataset.mood = 'idle'; }, ms); }
  function bounce(kind = 'bounce') { if (reduced()) return; root.classList.remove('is-bounce', 'is-hop'); void root.offsetWidth; root.classList.add(kind === 'hop' ? 'is-hop' : 'is-bounce'); later(() => root.classList.remove('is-bounce', 'is-hop'), 700); }
  function react(kind) {
    if (disposed) return;
    if (kind === 'tap') { setExpression('surprised', { hold: 420 }); later(() => { if (expression === 'neutral' || expression === 'surprised') setExpression('happy', { hold: 900 }); }, 420); bounce(); }
    else if (kind === 'wink') { setExpression('wink', { hold: 700 }); spawn('is-heart', { x: 50 + (random() - 0.5) * 30, y: 30 }); }
    else if (kind === 'dizzy') { setExpression('dizzy', { hold: 1600 }); gesture('wiggle'); }
    else if (kind === 'love') { setExpression('love', { hold: 1200 }); spawn('is-heart', { x: 40 + random() * 20, y: 25 }); }
    else if (kind === 'happy') { setExpression('happy', { hold: 1200 }); bounce(); }
    else if (kind === 'sleepy') setExpression('sleepy', { hold: 2500 });
    else if (kind === 'squint') setExpression('squint', { hold: 900 });
    else setExpression('neutral');
    setMood('reacting', 1200);
  }
  function feed() {
    if (disposed) return false;
    treats++; root.dataset.treats = String(treats);
    const treat = spawn('is-treat', { x: 92, y: 88, life: 1500 });
    if (treat) { const pose = current(); treat.style.setProperty('--mouth-x', pct(pose.mouth[0], pose.canvas[0])); treat.style.setProperty('--mouth-y', pct(pose.mouth[1], pose.canvas[1])); }
    later(() => { if (disposed) return; setExpression('squint', { hold: 700 }); gesture('ear-twitch'); root.classList.add('is-chomp'); later(() => root.classList.remove('is-chomp'), 700); spawn('is-nom', { x: 50, y: 48, text: 'nom', life: 1000 }); later(() => { setExpression('happy', { hold: 1400 }); bounce('hop'); root.style.setProperty('--wag-speed', '0.55s'); later(() => root.style.removeProperty('--wag-speed'), 2600); }, 650); }, reduced() ? 50 : 720);
    setMood('eating', 2400); return true;
  }
  function pointerMove(event) {
    if (disposed || !interactive) return;
    const vector = pointerVector(event); if (!vector.inside) { if (!petting) relax(); return; }
    root.classList.add('is-tracking'); look(vector.x, vector.y * 0.6);
    if (petting && lastPointer) {
      const distance = Math.hypot(event.clientX - lastPointer.x, event.clientY - lastPointer.y), elapsed = Math.max(1, clock() - lastPointer.at), speed = distance / elapsed;
      if (speed > 1.6 && spec.interaction === 'touch') react('dizzy');
      else if (distance > 8) { petHearts += distance; if (petHearts > 90) { petHearts = 0; spawn('is-heart', { x: 35 + random() * 30, y: 20 + random() * 25 }); if (expression !== 'love') setExpression(spec.interaction === 'treats' ? 'squint' : 'love'); root.style.setProperty('--wag-speed', '0.7s'); } }
    }
    lastPointer = { x: event.clientX, y: event.clientY, at: clock() };
  }
  function pointerDown(event) {
    if (disposed || !interactive || event.button > 0) return; const vector = pointerVector(event); if (!vector.inside) return;
    event.preventDefault(); petting = true; lastPointer = { x: event.clientX, y: event.clientY, at: clock() }; root.classList.add('is-petting'); setMood('petting');
    try { rig.setPointerCapture?.(event.pointerId); } catch { /* Capture is optional. */ }
    react('tap');
  }
  function pointerUp(event) {
    if (!petting) return; petting = false; petHearts = 0; root.classList.remove('is-petting'); root.style.removeProperty('--wag-speed'); setMood('idle');
    try { rig.releasePointerCapture?.(event.pointerId); } catch { /* Capture is optional. */ }
    if (clock() - (lastPointer?.at || 0) < 250) later(() => { if (expression === 'neutral') setExpression('happy', { hold: 900 }); }, 60);
    lastPointer = null; later(relax, 1600);
  }
  function doubleTap() { if (!interactive) return; react('wink'); }
  function showStage(target) { applyMetrics(stageRig(target)); root.dataset.stage = target; }
  function setStage(next, { animate = true } = {}) {
    const target = String(clamp(Number(next) || 1, 1, 3)), from = root.dataset.stage; if (target === from) return;
    root.setAttribute('aria-label', `${spec.name}, ${spec.evolutions[Number(target) - 1].title}`);
    buildPose(target);
    if (!animate || reduced() || Number(target) < Number(from)) { showStage(target); return; }
    root.classList.add('is-evolving'); setMood('evolving', 2600); setExpression('surprised', { hold: 1200 });
    for (let i = 0; i < 14; i++) later(() => spawn('is-spark', { x: 20 + random() * 60, y: 15 + random() * 70, life: 1300 }), i * 90);
    later(() => { showStage(target); setExpression('happy', { hold: 1800 }); bounce('hop'); }, 1200);
    later(() => root.classList.remove('is-evolving'), 2600);
  }
  function celebrate() {
    if (disposed) return; root.classList.add('is-celebrating'); setMood('celebrating', 4200); setExpression('happy', { hold: 3600 }); root.style.setProperty('--wag-speed', '0.5s');
    for (let i = 0; i < 26; i++) later(() => spawn('is-confetti', { x: random() * 100, y: -5, life: 2400 }), i * 70);
    later(() => { root.classList.remove('is-celebrating'); root.style.removeProperty('--wag-speed'); }, 4200);
  }
  function resume() { if (disposed || live) return; live = true; paused = false; root.classList.add('is-live'); root.dataset.motion = reduced() ? 'reduced' : 'full'; scheduleBlink(); scheduleGesture(); }
  function pause() { if (!live) return; live = false; root.classList.remove('is-live'); cancel(blinkTimer); cancel(gestureTimer); blinkTimer = gestureTimer = null; }
  const visibility = () => { if (document.hidden) pause(); else if (observerVisible) resume(); };
  let observerVisible = true;
  if (typeof window.IntersectionObserver === 'function') { observer = new window.IntersectionObserver(entries => { observerVisible = entries.some(entry => entry.isIntersecting); if (observerVisible && !document.hidden) resume(); else pause(); }, { threshold: 0.05 }); observer.observe(root); }
  else resume();
  document.addEventListener('visibilitychange', visibility);
  const motionChanged = () => { root.dataset.motion = reduced() ? 'reduced' : 'full'; if (live) { scheduleGesture(); } };
  motionQuery?.addEventListener?.('change', motionChanged);
  if (interactive) { rig.addEventListener('pointermove', pointerMove); rig.addEventListener('pointerdown', pointerDown); rig.addEventListener('pointerup', pointerUp); rig.addEventListener('pointercancel', pointerUp); rig.addEventListener('pointerleave', () => { if (!petting) later(relax, 400); }); rig.addEventListener('dblclick', doubleTap); rig.style.touchAction = 'none'; rig.classList.add('is-interactive'); }
  function destroy() { if (disposed) return; disposed = true; pause(); for (const id of timers) window.clearTimeout(id); timers.clear(); observer?.disconnect(); document.removeEventListener('visibilitychange', visibility); motionQuery?.removeEventListener?.('change', motionChanged); root.remove(); }
  return { element: root, theme: spec, setStage, celebrate, feed, react, look, pause, resume, destroy, get stage() { return Number(root.dataset.stage); }, get treats() { return treats; }, get pose() { return current(); } };
}
