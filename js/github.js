// Слой синхронизации с GitHub (роль «бэкенда» для статического сайта).
// Читает/коммитит JSON-файлы данных в приватный репозиторий и тянет
// бинарные файлы (mp3 песен, картинки) по токену.
// Токен хранится ТОЛЬКО в localStorage этого браузера.
import { GITHUB, KEYS } from "./config.js";

const API = "https://api.github.com";

// ── base64 <-> UTF-8 (кириллица корректно) ──────────────────────────
function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64DecodeUnicode(str) {
  return new TextDecoder().decode(b64ToBytes(str));
}
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

function headers(accept = "application/vnd.github+json") {
  return {
    Authorization: `Bearer ${getToken()}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}
function contentsUrl(path) {
  return `${API}/repos/${GITHUB.owner}/${GITHUB.repo}/contents/${path}`;
}

// Проверить, что токен реально видит приватный репозиторий данных.
export async function checkAccess() {
  const res = await fetch(`${API}/repos/${GITHUB.owner}/${GITHUB.repo}`, { headers: headers(), cache: "no-store" });
  if (res.status === 401) throw new Error("Неверный или просроченный токен (401). Скопируй токен заново (github_pat_…).");
  if (res.status === 403) throw new Error("Токену не хватает прав (403).");
  if (res.status === 404) throw new Error(`Токен не видит репозиторий «${GITHUB.repo}». Нужен доступ к нему с правом Contents: Read and write.`);
  if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`);
  return true;
}

// Файл на GitHub изменился с тех пор, как мы его читали.
export class ConflictError extends Error {}

// ── Универсальные pull/push JSON-файла ──────────────────────────────
async function pullJson(path, shaKey) {
  const url = `${contentsUrl(path)}?ref=${encodeURIComponent(GITHUB.branch)}`;
  const res = await fetch(url, { headers: headers(), cache: "no-store" });
  if (res.status === 404) return { data: null, sha: null }; // файла ещё нет
  if (!res.ok) throw new Error(`GitHub pull ${path}: ${res.status} ${res.statusText}`);
  const meta = await res.json();
  let b64 = meta.content;
  if (!b64 || meta.encoding === "none") {
    // файл больше 1 МБ — содержимое только через Blobs API
    const blob = await fetch(`${API}/repos/${GITHUB.owner}/${GITHUB.repo}/git/blobs/${meta.sha}`, { headers: headers(), cache: "no-store" });
    if (!blob.ok) throw new Error(`GitHub pull ${path}: ${blob.status}`);
    b64 = (await blob.json()).content;
  }
  localStorage.setItem(shaKey, meta.sha);
  return { data: JSON.parse(b64DecodeUnicode(b64)), sha: meta.sha };
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

  // 409 — sha устарел, 422 — sha не передан, а файл уже есть.
  // Вслепую не перезаписываем: пусть вызывающий сначала сольёт свежие данные.
  if (res.status === 409 || res.status === 422) throw new ConflictError(path);
  if (!res.ok) throw new Error(`GitHub push ${path}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  localStorage.setItem(shaKey, data.content.sha);
  localStorage.setItem(KEYS.lastSync, String(Date.now()));
  return data;
}

// ── Коллекции: words / songs / texts / assoc ────────────────────────
const SHA_KEY = { words: KEYS.shaWords, songs: KEYS.shaSongs, texts: KEYS.shaTexts, assoc: KEYS.shaAssoc };

export function pullCollection(name) {
  return pullJson(GITHUB.paths[name], SHA_KEY[name]).then((r) => r.data);
}
export function pushCollection(name, list, message = "Auto-sync from app") {
  return pushJson(GITHUB.paths[name], SHA_KEY[name], list, message);
}

// ── Бинарные ассеты из приватного репо (mp3, картинки) ──────────────
// Список файлов репо с их sha берём одним запросом (дерево), сами файлы
// качаем «сырыми» байтами и кладём в Cache Storage по sha — повторно
// песня включается мгновенно, даже после перезагрузки страницы.
const ASSET_CACHE = "it-assets-v1";
const urlCache = new Map();
let treePromise = null;

function repoTree() {
  if (!treePromise) {
    treePromise = fetch(`${API}/repos/${GITHUB.owner}/${GITHUB.repo}/git/trees/${encodeURIComponent(GITHUB.branch)}?recursive=1`,
      { headers: headers(), cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(`GitHub: ${r.status}`); return r.json(); })
      .then((j) => new Map(j.tree.filter((t) => t.type === "blob").map((t) => [t.path, t.sha])))
      .catch((err) => { treePromise = null; throw err; });
  }
  return treePromise;
}

async function openCache() {
  try { return "caches" in window ? await caches.open(ASSET_CACHE) : null; } catch { return null; }
}

export async function assetUrl(dir, name, mime = "application/octet-stream") {
  const path = `${dir}/${name}`.replace(/\/+/g, "/");
  if (urlCache.has(path)) return urlCache.get(path);

  const sha = (await repoTree()).get(path);
  if (!sha) throw new Error(`Файл ${path} не найден`);

  const cache = await openCache();
  const key = `/__asset/${sha}`;
  let res = cache && (await cache.match(key));
  if (!res) {
    const raw = await fetch(`${contentsUrl(path)}?ref=${encodeURIComponent(GITHUB.branch)}`, { headers: headers("application/vnd.github.raw") });
    if (!raw.ok) throw new Error(`Не удалось скачать ${path} (${raw.status})`);
    const blob = new Blob([await raw.arrayBuffer()], { type: mime });
    if (cache) cache.put(key, new Response(blob, { headers: { "Content-Type": mime } })).catch(() => {});
    res = new Response(blob);
  }
  const objUrl = URL.createObjectURL(new Blob([await res.blob()], { type: mime }));
  urlCache.set(path, objUrl);
  return objUrl;
}
