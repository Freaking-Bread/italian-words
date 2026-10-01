// Плеер: живёт поверх всех вкладок, помнит очередь, умеет loop и случайный переход.
import { GITHUB, KEYS } from "./config.js";
import { getSongs } from "./store.js";
import { assetUrl, isConfigured } from "./github.js";

const audio = document.getElementById("audio");

const state = {
  id: null,          // id играющей песни
  playing: false,
  loop: false,
  shuffle: true,     // по умолчанию дальше идёт случайная песня
  error: "",
  volume: 1,         // 0…1, запоминается в браузере
  muted: false,
};

// Громкость с прошлого раза
{
  const v = parseFloat(localStorage.getItem(KEYS.volume));
  if (v >= 0 && v <= 1) state.volume = v;
  state.muted = localStorage.getItem(KEYS.muted) === "1";
  audio.volume = state.volume;
  audio.muted = state.muted;
}

// На iPhone громкость задаётся только кнопками телефона — audio.volume
// там всегда 1. Тогда ползунок прячем, остаётся только «выключить звук».
export const volumeAdjustable = (() => {
  const probe = new Audio();
  probe.volume = 0.5;
  return probe.volume === 0.5;
})();

const listeners = new Set();
export function onPlayerChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function emit() { listeners.forEach((cb) => cb(state)); }

export function playerState() { return state; }
export function currentSong() { return state.id ? getSongs().find((s) => s.id === state.id) || null : null; }

const isUrl = (s = "") => /^(https?:|data:|blob:)/i.test(s);

// Кэш object-URL: один и тот же mp3 из приватного репо не качаем дважды.
const srcCache = new Map();
async function resolveSrc(song) {
  if (!song || !song.audio) return "";
  if (isUrl(song.audio)) return song.audio;
  if (srcCache.has(song.audio)) return srcCache.get(song.audio);
  if (!isConfigured()) throw new Error("Нужен токен: mp3 лежит в приватном репозитории");
  const url = await assetUrl(GITHUB.dirs.audio, song.audio, "audio/mpeg");
  srcCache.set(song.audio, url);
  return url;
}

// Песни, которые реально можно слушать
function playable() { return getSongs().filter((s) => s.audio); }

/** Запустить песню по id. Если она уже играет — пауза/продолжить. */
export async function play(id) {
  const song = getSongs().find((s) => s.id === id);
  if (!song) return;

  if (state.id === id && audio.src) { toggle(); return; }

  state.id = id;
  state.error = "";
  state.playing = false;
  emit();

  if (!song.audio) { state.error = "У этой песни не задан mp3"; emit(); return; }

  try {
    audio.src = await resolveSrc(song);
    audio.loop = state.loop;
    await audio.play();
  } catch (err) {
    state.error = err.message || "Не получилось включить";
    state.playing = false;
    emit();
  }
}

export function toggle() {
  if (!state.id) { const list = playable(); if (list.length) play(list[0].id); return; }
  if (audio.paused) audio.play().catch((e) => { state.error = e.message; emit(); });
  else audio.pause();
}

export function stop() {
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  state.id = null; state.playing = false;
  emit();
}

/** Следующая: при shuffle — случайная (но не та же самая), иначе по списку. */
export function next(manual = false) {
  const list = playable();
  if (!list.length) return;
  if (state.shuffle) { play(randomOther(list, state.id).id); return; }
  const i = list.findIndex((s) => s.id === state.id);
  const nextSong = list[(i + 1 + list.length) % list.length];
  play(nextSong.id);
  void manual;
}

export function prev() {
  const list = playable();
  if (!list.length) return;
  // первые 3 секунды — «в начало», дальше — предыдущая песня
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  const i = list.findIndex((s) => s.id === state.id);
  const prevSong = list[(i - 1 + list.length) % list.length];
  play(prevSong.id);
}

/** Случайная песня из списка, отличная от текущей (если есть выбор). */
function randomOther(list, exceptId) {
  const pool = list.length > 1 ? list.filter((s) => s.id !== exceptId) : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** Случайная песня прямо сейчас — кнопка «перемешать». */
export function playRandom() {
  const list = playable();
  if (!list.length) return null;
  const s = randomOther(list, state.id);
  play(s.id);
  return s;
}

export function setVolume(v) {
  state.volume = Math.min(1, Math.max(0, v));
  audio.volume = state.volume;
  // подвинул ползунок выше нуля — звук включается сам
  if (state.volume > 0 && state.muted) { state.muted = false; audio.muted = false; }
  localStorage.setItem(KEYS.volume, String(state.volume));
  localStorage.setItem(KEYS.muted, state.muted ? "1" : "0");
  emit();
}
export function toggleMute() {
  state.muted = !state.muted;
  audio.muted = state.muted;
  // включили звук, а громкость была на нуле — вернуть слышимую
  if (!state.muted && state.volume === 0) { state.volume = 0.6; audio.volume = 0.6; }
  localStorage.setItem(KEYS.muted, state.muted ? "1" : "0");
  localStorage.setItem(KEYS.volume, String(state.volume));
  emit();
}

export function setLoop(on) { state.loop = on; audio.loop = on; emit(); }
export function setShuffle(on) { state.shuffle = on; emit(); }
export function seekTo(ratio) { if (audio.duration) audio.currentTime = ratio * audio.duration; }

// ── Мостик к <audio> ────────────────────────────────────────────────
audio.addEventListener("play",  () => { state.playing = true;  emit(); });
audio.addEventListener("pause", () => { state.playing = false; emit(); });
audio.addEventListener("ended", () => {
  if (state.loop) return;              // loop делает сам <audio>
  next();
});
audio.addEventListener("error", () => {
  if (!audio.src) return;
  state.error = "Файл не открылся";
  state.playing = false;
  emit();
});

export function audioEl() { return audio; }

/** Два оттенка для «обложки» — стабильно выводятся из названия. */
export function hues(str = "") {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return { h1: h, h2: (h + 48) % 360 };
}

export function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
