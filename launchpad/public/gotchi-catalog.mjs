// Gotchi Mode catalogue shared by the server and the browser. Everything here is
// public, inert configuration: themes, milestones, the frozen funding policies
// and the display helpers that turn a pot value into an evolution stage.
// Monetary rules live on the server; this module never signs or submits.
export const GOTCHI_VERSION = 1;
export const GOTCHI_GOAL_USD = 10000;
export const GOTCHI_MILESTONES_USD = Object.freeze([2500, 5000, 10000]);
export const GOTCHI_TOP_HOLDERS = 10;
export const GOTCHI_WINNER_SPLIT_BPS = 5000;
export const GOTCHI_RAYDIUM_TAX_BPS = 100;
// Meteora DBC/DAMM take a 20% protocol share of trading fees. 252 bps with a
// 50/50 creator/partner split leaves 1.008% of volume for the Gotchi pot and
// 1.008% for the Launchpad protocol (the ordinary 188 bps/33% launch keeps its own
// 1.00768% partner share). The preset is frozen per launch; nothing recomputes it.
export const GOTCHI_METEORA_POLICY = Object.freeze({ preset: 'gotchi-1pct-v1', tradingFeeBps: 252, creatorSharePercent: 50, partnerSharePercent: 50, migrationFeePercentage: 0 });
export const GOTCHI_SAMPLE_INTERVAL_MS = 15 * 60 * 1000;
export const GOTCHI_MAX_SAMPLE_GAP_MS = 2 * 60 * 60 * 1000;

// Layered rigs. Each stage of a Gotchi is its own artwork cut into layers
// (tail, body, head, eyes or arrows) so the character breathes, blinks and wags
// at every evolution. Boxes and pivots are in canvas pixels of the source art.
const FOMOGOTCHI_RIGS = Object.freeze([
  Object.freeze({
    canvas: [1127, 1396], scale: 600 / 1127, figure: [11, 1330],
    layers: Object.freeze([
      Object.freeze({ name: 'tail', file: 'fomogotchi-tail.png', box: [683, 650, 1109, 1289], pivot: [760, 1140] }),
      Object.freeze({ name: 'body', file: 'fomogotchi-body.png', box: [226, 753, 839, 1330], pivot: [548, 1340] }),
      Object.freeze({ name: 'head', file: 'fomogotchi-head.png', box: [104, 11, 983, 785], pivot: [560, 830] }),
      Object.freeze({ name: 'eyes', file: 'fomogotchi-eyes.png', box: [295, 517, 788, 694], pivot: [541, 605] }),
    ]),
    eyes: Object.freeze({ left: [298, 520, 448, 690], right: [628, 520, 784, 690] }),
    mouth: [541, 700],
  }),
  Object.freeze({
    canvas: [1254, 1254], scale: 600 / 1254, figure: [30, 1252],
    layers: Object.freeze([
      Object.freeze({ name: 'tailtwo', file: 'fomogotchi-stage2-tailtwo.png', box: [64, 377, 534, 1055], pivot: [470, 850], mirror: true }),
      Object.freeze({ name: 'tail', file: 'fomogotchi-stage2-tail.png', box: [806, 577, 1199, 1153], pivot: [790, 850] }),
      Object.freeze({ name: 'body', file: 'fomogotchi-stage2-body.png', box: [83, 89, 1144, 1246], pivot: [640, 1250] }),
      Object.freeze({ name: 'head', file: 'fomogotchi-stage2-head.png', box: [384, 7, 1025, 629], pivot: [690, 640] }),
      Object.freeze({ name: 'eyes', file: 'fomogotchi-stage2-eyes.png', box: [555, 391, 883, 548], pivot: [718, 470] }),
    ]),
    eyes: Object.freeze({ left: [562, 398, 690, 515], right: [755, 428, 875, 540] }),
    mouth: [720, 560],
  }),
  Object.freeze({
    canvas: [1254, 1254], scale: 600 / 1254, figure: [0, 1252],
    layers: Object.freeze([
      Object.freeze({ name: 'tailtwo', file: 'fomogotchi-stage3-tailtwo.png', box: [13, 398, 556, 1082], pivot: [480, 820], mirror: true }),
      Object.freeze({ name: 'tail', file: 'fomogotchi-stage3-tail.png', box: [776, 363, 1243, 1118], pivot: [820, 820] }),
      Object.freeze({ name: 'body', file: 'fomogotchi-stage3-body.png', box: [14, 108, 1230, 1240], pivot: [640, 1250] }),
      Object.freeze({ name: 'head', file: 'fomogotchi-stage3-head.png', box: [379, 6, 978, 589], pivot: [680, 600] }),
      Object.freeze({ name: 'eyes', file: 'fomogotchi-stage3-eyes.png', box: [555, 375, 846, 514], pivot: [700, 444] }),
    ]),
    eyes: Object.freeze({ left: [562, 382, 672, 478], right: [728, 410, 838, 506] }),
    mouth: [700, 510],
  }),
]);
const PUMPGOTCHI_RIGS = Object.freeze([
  Object.freeze({
    canvas: [1135, 1386], scale: 600 / 1135, figure: [27, 1324],
    layers: Object.freeze([
      Object.freeze({ name: 'tail', file: 'pumpgotchi-tail.png', box: [795, 707, 1135, 1277], pivot: [900, 1200] }),
      Object.freeze({ name: 'body', file: 'pumpgotchi-body.png', box: [214, 780, 934, 1324], pivot: [560, 1330] }),
      Object.freeze({ name: 'head', file: 'pumpgotchi-head.png', box: [33, 27, 1027, 850], pivot: [545, 820] }),
      Object.freeze({ name: 'eyes', file: 'pumpgotchi-eyes.png', box: [192, 502, 884, 676], pivot: [537, 590] }),
    ]),
    eyes: Object.freeze({ left: [195, 505, 420, 672], right: [650, 505, 880, 672] }),
    mouth: [540, 700], crest: [405, 300, 685, 500], charm: [462, 855, 598, 1000],
  }),
  Object.freeze({
    canvas: [1254, 1254], scale: 600 / 1254, figure: [20, 1215],
    layers: Object.freeze([
      Object.freeze({ name: 'tail', file: 'pumpgotchi-stage2-tail.png', box: [55, 265, 467, 914], pivot: [470, 880], mirror: true }),
      Object.freeze({ name: 'body', file: 'pumpgotchi-stage2-body.png', box: [55, 83, 1113, 1247], pivot: [650, 1215] }),
      Object.freeze({ name: 'head', file: 'pumpgotchi-stage2-head.png', box: [447, 5, 1150, 619], pivot: [820, 620] }),
      Object.freeze({ name: 'eyes', file: 'pumpgotchi-stage2-eyes.png', box: [630, 360, 1079, 561], pivot: [854, 460] }),
    ]),
    eyes: Object.freeze({ left: [642, 372, 806, 500], right: [912, 436, 1066, 548] }),
    mouth: [850, 560], charm: [800, 640, 905, 790],
  }),
  Object.freeze({
    canvas: [1254, 1254], scale: 600 / 1254, figure: [20, 1225],
    layers: Object.freeze([
      Object.freeze({ name: 'tail', file: 'pumpgotchi-stage3-tail.png', box: [813, 218, 1241, 923], pivot: [900, 720] }),
      Object.freeze({ name: 'body', file: 'pumpgotchi-stage3-body.png', box: [93, 230, 1240, 1225], pivot: [640, 1225] }),
      Object.freeze({ name: 'head', file: 'pumpgotchi-stage3-head.png', box: [93, 0, 811, 569], pivot: [450, 580] }),
      Object.freeze({ name: 'eyes', file: 'pumpgotchi-stage3-eyes.png', box: [276, 324, 709, 483], pivot: [492, 403] }),
    ]),
    eyes: Object.freeze({ left: [288, 336, 450, 450], right: [546, 370, 696, 470] }),
    mouth: [480, 495], charm: [380, 590, 470, 715],
  }),
]);

export const GOTCHI_THEMES = Object.freeze([
  Object.freeze({
    id: 'fomogotchi', name: 'Fomogotchi', species: 'Chibi fox', interaction: 'treats',
    tagline: 'A navy-and-white fox with a gradient tail that never stops wagging.',
    description: 'Fomogotchi feeds on attention. Launch a coin on his team, graduate it, and every trade stocks his prize pot. Feed him treats and pet him while you wait.',
    palette: Object.freeze({ primary: '#1b1a3a', secondary: '#fff6ff', accentA: '#ff6a3d', accentB: '#ff2e8b', accentC: '#8a3bff', glow: '#ff7ad9', sky: '#2a1e5c' }),
    evolutions: Object.freeze([
      Object.freeze({ stage: 1, title: 'Kit', blurb: 'Fresh out of the den. Curious, hungry, easily hyped.' }),
      Object.freeze({ stage: 2, title: 'Trailblazer', blurb: 'A second gradient tail flares out and the bandana goes on. He has seen a green candle.' }),
      Object.freeze({ stage: 3, title: 'Kitsune Fomo', blurb: 'Four gradient tails fanned wide and an aura of pure FOMO. The race is nearly over.' }),
    ]),
    rig: FOMOGOTCHI_RIGS[0], stages: FOMOGOTCHI_RIGS,
  }),
  Object.freeze({
    id: 'pumpgotchi', name: 'Pumpgotchi', species: 'Chevron cat', interaction: 'treats',
    tagline: 'A mint-green cat with a chevron crest, a capsule charm and an arrow-tipped tail.',
    description: 'Pumpgotchi only knows one direction: up. Launch a coin on his team, graduate it, and every trade fills his prize pot. Pet him, feed him treats and watch the capsule charm start to glow.',
    palette: Object.freeze({ primary: '#8fe0bd', secondary: '#0e3f30', accentA: '#39f0a8', accentB: '#ffd23f', accentC: '#0f6b4b', glow: '#8dffd4', sky: '#0f2a28' }),
    evolutions: Object.freeze([
      Object.freeze({ stage: 1, title: 'Kitten', blurb: 'Soft paws, sharp eyes, already watching the chart.' }),
      Object.freeze({ stage: 2, title: 'Pumped', blurb: 'On all fours and prowling, with a plume of a tail and the capsule charm lit on a collar.' }),
      Object.freeze({ stage: 3, title: 'Moon Cat', blurb: 'A full mane, zigzag markings and fangs out. Send it.' }),
    ]),
    rig: PUMPGOTCHI_RIGS[0], stages: PUMPGOTCHI_RIGS,
  }),
]);

const byId = new Map(GOTCHI_THEMES.map(theme => [theme.id, theme]));
export const GOTCHI_IDS = Object.freeze(GOTCHI_THEMES.map(theme => theme.id));
export function validGotchiId(value) { return typeof value === 'string' && byId.has(value); }
export function gotchiTheme(id) { return byId.get(id) || null; }
export function requireGotchiTheme(id) {
  const theme = gotchiTheme(id);
  if (!theme) throw Object.assign(Error('Choose a Gotchi to pair your coin with.'), { statusCode: 400 });
  return theme;
}

// Stage 1 below the first milestone, stage 2 from $2,500 and stage 3 from
// $5,000. $10,000 ends the race, so the final form celebrates, then resets.
export function evolutionStage(potUsd) {
  const value = Number(potUsd);
  if (!Number.isFinite(value) || value < GOTCHI_MILESTONES_USD[0]) return 1;
  return value < GOTCHI_MILESTONES_USD[1] ? 2 : 3;
}
export function milestoneProgress(potUsd) {
  const value = Math.max(0, Number.isFinite(Number(potUsd)) ? Number(potUsd) : 0);
  const reached = GOTCHI_MILESTONES_USD.filter(level => value >= level);
  const next = GOTCHI_MILESTONES_USD.find(level => value < level) ?? null;
  const previous = reached.length ? reached[reached.length - 1] : 0;
  const span = next === null ? 1 : next - previous;
  return { reached, next, stage: evolutionStage(value), percentToGoal: Math.min(100, value / GOTCHI_GOAL_USD * 100), percentToNext: next === null ? 100 : Math.min(100, (value - previous) / span * 100) };
}

// Plain-language fee disclosure for the launch review and the Gotchi rules.
// Raydium: a 1% Token-2022 transfer tax funds the pot through the existing tax
// machinery; Launchpad keeps its 5% share of converted tax. Meteora: the creator
// fee allocation of a 2.52% trading fee is routed to the pot (no transfer tax).
export function gotchiFundingSummary(venue) {
  // Pump.fun: the coin's native creator-fee share is distributed to a per-coin
  // Launchpad relay wallet and swept to the pot. Launchpad's platform share is published
  // in the docs (Fees & revenue) and deliberately not repeated here.
  if (venue === 'pump') return { venue, grossPercent: null, venuePercent: null, protocolPercent: null, potPercent: null, transferTaxPercent: 0,
    text: 'Pump.fun launches keep Pump.fun’s standard fees. The coin’s creator-fee share fills the Gotchi pot after Launchpad’s platform share (see Fees & revenue in the docs). There is no transfer tax and the creator earns no separate fee.' };
  if (venue === 'meteora') {
    const protocolTake = 0.2, pot = GOTCHI_METEORA_POLICY.tradingFeeBps / 100 * (1 - protocolTake) * GOTCHI_METEORA_POLICY.creatorSharePercent / 100;
    const protocol = GOTCHI_METEORA_POLICY.tradingFeeBps / 100 * (1 - protocolTake) * GOTCHI_METEORA_POLICY.partnerSharePercent / 100;
    return { venue, grossPercent: GOTCHI_METEORA_POLICY.tradingFeeBps / 100, venuePercent: GOTCHI_METEORA_POLICY.tradingFeeBps / 100 * protocolTake, protocolPercent: protocol, potPercent: pot, transferTaxPercent: 0,
      text: `Meteora launches charge a ${(GOTCHI_METEORA_POLICY.tradingFeeBps / 100).toFixed(2)}% trading fee: Meteora keeps 20% of it, ${pot.toFixed(3)}% of volume goes to the Gotchi pot and ${protocol.toFixed(3)}% to the Launchpad protocol. There is no transfer tax and the creator earns no separate fee.` };
  }
  const gross = GOTCHI_RAYDIUM_TAX_BPS / 100;
  return { venue: 'raydium', grossPercent: gross, venuePercent: 0, protocolPercent: gross * 0.05, potPercent: gross * 0.95, transferTaxPercent: gross,
    text: `Raydium launches carry a ${gross.toFixed(2)}% transfer tax on every buy, sell and transfer. Collected tax is sold for SOL by the existing tax machinery: 5% of proceeds (${(gross * 0.05).toFixed(3)}% of taxed volume) goes to the Launchpad protocol and 95% (${(gross * 0.95).toFixed(3)}%) to the Gotchi pot. The curve creator fee is 0%.` };
}

export const GOTCHI_RULES = Object.freeze([
  'Pick a Gotchi when you launch. The pairing is permanent and written into the coin record.',
  'Only graduated coins compete. Until a coin graduates it funds the pot but its holders earn no race time.',
  'Every trade on a Gotchi coin feeds the pot: 1% transfer tax on Raydium, the creator fee allocation on Meteora.',
  `The Gotchi evolves at $${GOTCHI_MILESTONES_USD[0].toLocaleString()} and $${GOTCHI_MILESTONES_USD[1].toLocaleString()} of realized pot value.`,
  `When the realized pot reaches $${GOTCHI_GOAL_USD.toLocaleString()} the race closes. The graduated coin with the highest USD market cap at the cutoff wins.`,
  `The ${GOTCHI_TOP_HOLDERS} wallets with the highest time-averaged USD holdings across the Gotchi's graduated coins, measured over the whole race, share the pot.`,
  'Half the pot buys the winning coin and half stays SOL. Both are airdropped in proportion to each winner’s share, after network fees, rent and rounding are set aside.',
  'Custody wallets, pool vaults, burn addresses and Gotchi wallets never count as holders. Ties are settled deterministically and published.',
  'Remainders and dust carry into the next race. Nothing is skimmed from the pot.',
]);
