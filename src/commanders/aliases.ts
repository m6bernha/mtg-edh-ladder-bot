/**
 * Community nicknames that the tiered search would otherwise rank low or miss.
 * Keys are matched after normalizeName(), so write them lowercase and unpunctuated.
 * Values must be exact Scryfall names; `npm run sync-commanders` warns about any
 * alias whose target is not in the synced index.
 *
 * Do not add plain prefixes ("edgar" → Edgar Markov) — the PREFIX tier already
 * handles those. Add entries only when the nickname is not literally the start
 * of the name.
 */
export const ALIASES: Record<string, string> = {
  urdragon: 'The Ur-Dragon',
  'ur dragon': 'The Ur-Dragon',
  gitrog: 'The Gitrog Monster',
  'gitrog monster': 'The Gitrog Monster',
  'scarab god': 'The Scarab God',
  'locust god': 'The Locust God',
  'scorpion god': 'The Scorpion God',
  mimeoplasm: 'The Mimeoplasm',
  'first sliver': 'The First Sliver',
  'wise mothman': 'The Wise Mothman',
  necrobloom: 'The Necrobloom',
  'ancient one': 'The Ancient One',
  'master transcendent': 'The Master, Transcendent',
  krrik: "K'rrik, Son of Yawgmoth",
  tymna: 'Tymna the Weaver',
  thrasios: 'Thrasios, Triton Hero',
  rogsi: 'Rograkh, Son of Rohgahh',
  rog: 'Rograkh, Son of Rohgahh',
  kefnet: 'God-Eternal Kefnet',
  oketra: 'God-Eternal Oketra',
  rhonas: 'God-Eternal Rhonas',
  bontu: 'God-Eternal Bontu',
  'prime speaker': 'Prime Speaker Zegana',
  'mothman': 'The Wise Mothman',
  'ur dragon scion': 'Scion of the Ur-Dragon',
};
