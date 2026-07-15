// Слой данных: состояние (слова + песни) + localStorage + загрузка стартовых списков.
// CRUD над словами и песнями + простая реактивность через подписки.
import { KEYS, DATA_URL } from "./config.js";

let words = [];
let songs = [];
const listeners = new Set();

function emit() {
  persistLocal();
  listeners.forEach((fn) => fn());
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ── Геттеры / сеттеры ────────────────────────────────────────────────
export function getWords() { return words; }
export function getSongs() { return songs; }

export function setWords(next, { silent = false } = {}) {
  words = Array.isArray(next) ? next : [];
  silent ? persistLocal() : emit();
}
export function setSongs(next, { silent = false } = {}) {
  songs = Array.isArray(next) ? next : [];
  silent ? persistLocal() : emit();
}

function persistLocal() {
  localStorage.setItem(KEYS.words, JSON.stringify(words));
  localStorage.setItem(KEYS.songs, JSON.stringify(songs));
}

// Первичная загрузка: сначала localStorage, иначе стартовые демо-файлы.
export async function loadInitial() {
  words = await loadPart(KEYS.words, DATA_URL.words);
  songs = await loadPart(KEYS.songs, DATA_URL.songs);
  persistLocal();
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

// ── Слова / связки / правила ─────────────────────────────────────────
export function addWord({ word, meaning = "", example = "", exampleRu = "", image = "", category = "word" }) {
  const now = Date.now();
  const item = {
    id: uid("w_"),
    word: word.trim(), meaning: meaning.trim(),
    example: example.trim(), exampleRu: exampleRu.trim(),
    image: image.trim(),
    learned: false, category,
    createdAt: now, updatedAt: now,
  };
  words = [item, ...words];
  emit();
  return item;
}

export function updateWord(id, patch) {
  words = words.map((w) => (w.id === id ? { ...w, ...patch, updatedAt: Date.now() } : w));
  emit();
}
export function deleteWord(id) {
  words = words.filter((w) => w.id !== id);
  emit();
}
export function toggleLearned(id) {
  const w = words.find((x) => x.id === id);
  if (w) updateWord(id, { learned: !w.learned });
}

// ── Песни ────────────────────────────────────────────────────────────
export function addSong({ title, artist = "", audio = "", lyrics = [] }) {
  const now = Date.now();
  const item = {
    id: uid("s_"),
    title: title.trim(), artist: artist.trim(), audio: audio.trim(),
    lyrics, createdAt: now, updatedAt: now,
  };
  songs = [item, ...songs];
  emit();
  return item;
}
export function updateSong(id, patch) {
  songs = songs.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s));
  emit();
}
export function deleteSong(id) {
  songs = songs.filter((s) => s.id !== id);
  emit();
}
