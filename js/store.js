// Слой данных: слова, песни, тексты, ассоциации + localStorage + слияние с GitHub.
// Каждая правка помечает коллекцию «грязной» — на GitHub уходит только она.
// Удаления запоминаются (tombstones), чтобы слияние их не воскрешало,
// а новые ещё не отправленные записи (pending) — чтобы слияние их не потеряло.
import { KEYS, DATA_URL } from "./config.js";

export const COLLECTIONS = ["words", "songs", "texts", "assoc"];
const STORE_KEY = { words: KEYS.words, songs: KEYS.songs, texts: KEYS.texts, assoc: KEYS.assoc };

const data = { words: [], songs: [], texts: [], assoc: [] };
const listeners = new Set();

// ── Служебное состояние синхронизации (в localStorage) ──────────────
const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
let dirty = new Set(readJson(KEYS.dirty, []));
let tomb = readJson(KEYS.tomb, {});
let pending = readJson(KEYS.pending, {});   // { words: [id…], … }

function saveMeta() {
  localStorage.setItem(KEYS.dirty, JSON.stringify([...dirty]));
  localStorage.setItem(KEYS.tomb, JSON.stringify(tomb));
  localStorage.setItem(KEYS.pending, JSON.stringify(pending));
}
const pendingSet = (name) => new Set(pending[name] || []);

export function dirtyCollections() { return [...dirty]; }
// Коллекция успешно ушла на GitHub. Снимок — то, что реально отправили:
// если пока шёл запрос появились новые правки, флаг остаётся.
export function markPushed(name, sentList) {
  if (sentList === data[name]) dirty.delete(name);
  const sent = new Set(sentList.map((x) => x.id));
  pending[name] = (pending[name] || []).filter((id) => !sent.has(id));
  saveMeta();
}

// ── Реактивность ─────────────────────────────────────────────────────
// change = { collection, id?, quiet? } — quiet: интерфейс обновит себя точечно
function emit(change) {
  persist(change.collection);
  listeners.forEach((fn) => fn(change));
}
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function persist(name) {
  const names = name ? [name] : COLLECTIONS;
  names.forEach((n) => localStorage.setItem(STORE_KEY[n], JSON.stringify(data[n])));
}

function touch(name, change = {}) {
  dirty.add(name);
  saveMeta();
  emit({ collection: name, ...change });
}

// ── Геттеры / сеттеры ────────────────────────────────────────────────
export const getWords = () => data.words;
export const getSongs = () => data.songs;
export const getTexts = () => data.texts;
export const getAssoc = () => data.assoc;
export const getList = (name) => data[name];

// Полная замена коллекции (ручная загрузка из GitHub)
export function setList(name, next, { silent = false } = {}) {
  data[name] = Array.isArray(next) ? next : [];
  if (silent) persist(name);
  else emit({ collection: name });
}

// Слить данные с GitHub с локальными:
//  • запись есть в обоих местах → побеждает более свежая (updatedAt);
//  • только на GitHub → берём, если мы её здесь не удаляли;
//  • только локально → оставляем, если она новая и ещё не отправлена
//    (иначе её удалили на другом устройстве).
export function mergeRemote(name, remote) {
  if (!Array.isArray(remote)) return false;
  const local = data[name];
  const fresh = pendingSet(name);
  const localById = new Map(local.map((x) => [x.id, x]));
  const remoteIds = new Set(remote.map((r) => r.id));
  const fromRemote = remote
    .filter((r) => !tomb[r.id])
    .map((r) => {
      const l = localById.get(r.id);
      return l && (l.updatedAt || 0) > (r.updatedAt || 0) ? l : r;
    });
  const localOnly = local.filter((l) => !remoteIds.has(l.id) && fresh.has(l.id));
  const merged = [...localOnly, ...fromRemote];

  const changedVsLocal = JSON.stringify(merged) !== JSON.stringify(local);
  const differsFromRemote = JSON.stringify(merged) !== JSON.stringify(remote);
  data[name] = merged;
  persist(name);
  if (differsFromRemote) { dirty.add(name); } else { dirty.delete(name); }
  saveMeta();
  return changedVsLocal;
}

// ── Первичная загрузка: localStorage, иначе демо-файлы ──────────────
export async function loadInitial() {
  await Promise.all(COLLECTIONS.map(async (n) => { data[n] = await loadPart(STORE_KEY[n], DATA_URL[n]); }));
  persist();
  // старые удаления (старше 90 дней) больше не нужны
  const cutoff = Date.now() - 90 * 864e5;
  for (const id in tomb) if (tomb[id] < cutoff) delete tomb[id];
  saveMeta();
}

async function loadPart(cacheKey, url) {
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch { /* повреждённый кэш */ }
  }
  try {
    const res = await fetch(url, { cache: "no-store" });
    return await res.json();
  } catch {
    return [];
  }
}

function uid(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── Общие CRUD-помощники ─────────────────────────────────────────────
function addItem(name, item) {
  data[name] = [item, ...data[name]];
  pending[name] = [...(pending[name] || []), item.id];
  touch(name, { id: item.id });
  return item;
}
function updateItem(name, id, patch, opts) {
  data[name] = data[name].map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x));
  touch(name, { id, ...opts });
}
function deleteItem(name, id) {
  data[name] = data[name].filter((x) => x.id !== id);
  tomb[id] = Date.now();
  pending[name] = (pending[name] || []).filter((x) => x !== id);
  touch(name, { id });
}

// ── Слова / связки / правила / мат ───────────────────────────────────
export function addWord({ word, meaning = "", example = "", exampleRu = "", image = "", category = "word" }) {
  const now = Date.now();
  return addItem("words", {
    id: uid("w_"),
    word: word.trim(), meaning: meaning.trim(),
    example: example.trim(), exampleRu: exampleRu.trim(),
    image: image.trim(),
    learned: false, category,
    createdAt: now, updatedAt: now,
  });
}
export const updateWord = (id, patch) => updateItem("words", id, patch);
export const deleteWord = (id) => deleteItem("words", id);

// quiet — карточку на экране интерфейс обновит сам, без полной перерисовки
export function setLearned(id, learned, { quiet = false } = {}) {
  updateItem("words", id, { learned }, { quiet });
}
export function toggleLearned(id, opts) {
  const w = data.words.find((x) => x.id === id);
  if (w) setLearned(id, !w.learned, opts);
}

// ── Песни ────────────────────────────────────────────────────────────
export function addSong({ title, artist = "", audio = "", lyrics = [] }) {
  const now = Date.now();
  return addItem("songs", {
    id: uid("s_"),
    title: title.trim(), artist: artist.trim(), audio: audio.trim(),
    lyrics, createdAt: now, updatedAt: now,
  });
}
export const updateSong = (id, patch) => updateItem("songs", id, patch);
export const deleteSong = (id) => deleteItem("songs", id);

// ── Тексты для заучивания (без перевода) ─────────────────────────────
export function addText({ title, body = "" }) {
  const now = Date.now();
  return addItem("texts", { id: uid("t_"), title: title.trim(), body: body.trim(), createdAt: now, updatedAt: now });
}
export const updateText = (id, patch) => updateItem("texts", id, patch);
export const deleteText = (id) => deleteItem("texts", id);

// ── Ассоциации (картинки-подсказки к словам) ─────────────────────────
export function addAssoc({ title, image = "", note = "" }) {
  const now = Date.now();
  return addItem("assoc", { id: uid("a_"), title: title.trim(), image: image.trim(), note: note.trim(), createdAt: now, updatedAt: now });
}
export const updateAssoc = (id, patch) => updateItem("assoc", id, patch);
export const deleteAssoc = (id) => deleteItem("assoc", id);
