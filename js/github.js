// Слой синхронизации с GitHub (роль «бэкенда» для статического сайта).
// Читает/коммитит words.json и songs.json в приватный репозиторий данных,
// а также умеет тянуть бинарные файлы (mp3 песен, картинки правил) по токену.
// Токен хранится ТОЛЬКО в localStorage этого браузера.
import { GITHUB, KEYS } from "./config.js";

const API = "https://api.github.com";

// ── base64 <-> UTF-8 (кириллица корректно) ──────────────────────────
function b64EncodeUnicode(str) {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode("0x" + p1))
  );
}
function b64DecodeUnicode(str) {
  return decodeURIComponent(
    atob(str).split("").map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2)).join("")
  );
}
// base64 -> сырые байты (для mp3/картинок)
function b64ToBytes(b64) {
  const bin = atob(b64.replace(/\n/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ── Токен ────────────────────────────────────────────────────────────
export function getToken() { return localStorage.getItem(KEYS.token) || ""; }
export function setToken(t) {
  if (t) localStorage.setItem(KEYS.token, t.trim());
  else localStorage.removeItem(KEYS.token);
}
export function isConfigured() { return Boolean(GITHUB.owner && GITHUB.repo && getToken()); }

function headers() {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
function contentsUrl(path) {
  return `${API}/repos/${GITHUB.owner}/${GITHUB.repo}/contents/${path}`;
}

// Проверить, что токен реально видит приватный репозиторий данных.
export async function checkAccess() {
  const res = await fetch(`${API}/repos/${GITHUB.owner}/${GITHUB.repo}`, { headers: headers() });
  if (res.status === 401) throw new Error("Неверный или просроченный токен (401). Скопируй токен заново (github_pat_…).");
  if (res.status === 403) throw new Error("Токену не хватает прав (403).");
  if (res.status === 404) throw new Error(`Токен не видит репозиторий «${GITHUB.repo}». Нужен доступ к нему с правом Contents: Read and write.`);
  if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`);
  return true;
}

// ── Универсальные pull/push JSON-файла ──────────────────────────────
async function pullJson(path, shaKey) {
  const url = `${contentsUrl(path)}?ref=${encodeURIComponent(GITHUB.branch)}`;
  const res = await fetch(url, { headers: headers() });
  if (res.status === 404) return { data: null, sha: null }; // файла ещё нет
  if (!res.ok) throw new Error(`GitHub pull ${path}: ${res.status} ${res.statusText}`);
  const meta = await res.json();
  const json = b64DecodeUnicode(meta.content);
  localStorage.setItem(shaKey, meta.sha);
  return { data: JSON.parse(json), sha: meta.sha };
}

async function pushJson(path, shaKey, obj, message) {
  const body = {
    message,
    content: b64EncodeUnicode(JSON.stringify(obj, null, 2)),
    branch: GITHUB.branch,
  };
  const sha = localStorage.getItem(shaKey);
  if (sha) body.sha = sha;

  const res = await fetch(contentsUrl(path), {
    method: "PUT",
    headers: { ...headers(), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 409) {
    // конфликт версий: подтягиваем свежий sha и повторяем
    const fresh = await pullJson(path, shaKey);
    localStorage.setItem(shaKey, fresh.sha || "");
    return pushJson(path, shaKey, obj, message);
  }
  if (!res.ok) throw new Error(`GitHub push ${path}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  localStorage.setItem(shaKey, data.content.sha);
  localStorage.setItem(KEYS.lastSync, String(Date.now()));
  return data;
}

// ── Публичные обёртки для слов и песен ──────────────────────────────
export async function pullWords() {
  const { data } = await pullJson(GITHUB.paths.words, KEYS.shaWords);
  return { words: data };
}
export async function pullSongs() {
  const { data } = await pullJson(GITHUB.paths.songs, KEYS.shaSongs);
  return { songs: data };
}
export async function pullTexts() {
  const { data } = await pullJson(GITHUB.paths.texts, KEYS.shaTexts);
  return { texts: data };
}
export function pushWords(words, message = "Update words") {
  return pushJson(GITHUB.paths.words, KEYS.shaWords, words, message);
}
export function pushSongs(songs, message = "Update songs") {
  return pushJson(GITHUB.paths.songs, KEYS.shaSongs, songs, message);
}
export function pushTexts(texts, message = "Update texts") {
  return pushJson(GITHUB.paths.texts, KEYS.shaTexts, texts, message);
}
export async function pullAssoc() {
  const { data } = await pullJson(GITHUB.paths.assoc, KEYS.shaAssoc);
  return { assoc: data };
}
export function pushAssoc(assoc, message = "Update assoc") {
  return pushJson(GITHUB.paths.assoc, KEYS.shaAssoc, assoc, message);
}

// ── Бинарные ассеты из приватного репо (mp3, картинки) ──────────────
// Возвращает object URL, который можно подставить в <audio src> / <img src>.
// Кэшируем в памяти, чтобы не тянуть один и тот же файл повторно.
const assetCache = new Map();

export async function assetUrl(dir, name, mime = "application/octet-stream") {
  const path = `${dir}/${name}`.replace(/\/+/g, "/");
  if (assetCache.has(path)) return assetCache.get(path);

  // 1) метаданные файла
  const metaRes = await fetch(`${contentsUrl(path)}?ref=${encodeURIComponent(GITHUB.branch)}`, { headers: headers() });
  if (!metaRes.ok) throw new Error(`Файл ${path} не найден (${metaRes.status})`);
  const meta = await metaRes.json();

  // 2) содержимое: маленькие файлы приходят в base64 сразу,
  //    большие (>1 МБ) тянем через Blobs API по sha.
  let b64 = meta.content;
  if (!b64 || meta.encoding === "none") {
    const blobRes = await fetch(`${API}/repos/${GITHUB.owner}/${GITHUB.repo}/git/blobs/${meta.sha}`, { headers: headers() });
    if (!blobRes.ok) throw new Error(`Не удалось скачать ${path} (${blobRes.status})`);
    b64 = (await blobRes.json()).content;
  }

  const blob = new Blob([b64ToBytes(b64)], { type: mime });
  const objUrl = URL.createObjectURL(blob);
  assetCache.set(path, objUrl);
  return objUrl;
}
