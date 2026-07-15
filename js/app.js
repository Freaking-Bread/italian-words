// Интерфейс: рендер слов и песен, редактирование, синхронизация, тема.
import { KEYS, GITHUB } from "./config.js";
import {
  loadInitial, subscribe,
  getWords, setWords, addWord, updateWord, deleteWord, toggleLearned,
  getSongs, setSongs, addSong, updateSong, deleteSong,
} from "./store.js";
import {
  pullWords, pullSongs, pushWords, pushSongs,
  getToken, setToken, isConfigured, checkAccess, assetUrl,
} from "./github.js";

const SECTION_LABEL = { word: "слово", linker: "связку", rule: "правило", song: "песню" };

// ── Состояние интерфейса ─────────────────────────────────────────────
const ui = { section: "word", filter: "learning", query: "", editMode: false, openSongId: null };

const $ = (sel, root = document) => root.querySelector(sel);
const grid = $("#grid");
const empty = $("#empty");

function toast(msg, type = "") {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast is-visible " + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.className = "toast"), 2600);
}

function esc(s = "") {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Убрать ведущий артикль — для озвучки и внешних ссылок (il/la/l'/gli…).
function coreWord(s = "") {
  return s
    .replace(/^\s*(l'|un')/i, "")
    .replace(/^\s*(il|lo|la|i|gli|le|un|uno|una)\s+/i, "")
    .trim();
}

// ── Внешние ссылки для итальянского ──────────────────────────────────
function reversoUrl(word) {
  return `https://context.reverso.net/translation/italian-russian/${encodeURIComponent(coreWord(word))}`;
}
function youglishUrl(word) {
  return `https://youglish.com/pronounce/${encodeURIComponent(coreWord(word))}/italian`;
}
function speak(word) {
  if (!("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(coreWord(word));
  u.lang = "it-IT";
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// Разрешить картинку/аудио: если это ссылка — отдаём как есть,
// иначе тянем из приватного репо по токену (async).
function isUrl(s = "") { return /^(https?:|data:|blob:)/i.test(s); }

async function resolveAsset(el, dir, name, mime) {
  if (isUrl(name)) { el.src = name; return; }
  if (!isConfigured()) return; // без токена приватный файл не достать
  try {
    el.src = await assetUrl(dir, name, mime);
  } catch (err) {
    console.warn("asset:", err.message);
  }
}

// ── Фильтрация слов ──────────────────────────────────────────────────
function visibleWords() {
  const q = ui.query.trim().toLowerCase();
  return getWords().filter((w) => {
    if ((w.category || "word") !== ui.section) return false;
    if (ui.filter === "learned" && !w.learned) return false;
    if (ui.filter === "learning" && w.learned) return false;
    if (!q) return true;
    return (
      w.word.toLowerCase().includes(q) ||
      (w.meaning || "").toLowerCase().includes(q) ||
      (w.example || "").toLowerCase().includes(q)
    );
  });
}

// ── Карточка слова / связки / правила ────────────────────────────────
function cardHtml(w) {
  const cat = w.category || "word";
  const isRule = cat === "rule";
  const learnedCls = w.learned ? "is-learned" : "";

  const head = isRule
    ? `<p class="card__rule">${esc(w.word)}</p>`
    : `<div class="card__word-row">
         <h3 class="card__word">${esc(w.word)}</h3>
         <button class="mini-btn" data-act="speak" title="Произнести">🔊</button>
       </div>`;

  const meaning = w.meaning
    ? `<p class="card__meaning">${esc(w.meaning)}</p>`
    : isRule ? "" : `<p class="card__meaning"><span class="muted">— нет перевода —</span></p>`;

  const example = w.example
    ? `<p class="card__example">${esc(w.example)}</p>
       ${w.exampleRu ? `<p class="card__example-ru">${esc(w.exampleRu)}</p>` : ""}`
    : "";

  const image = isRule && w.image
    ? `<img class="card__img" alt="" ${isUrl(w.image) ? `src="${esc(w.image)}"` : `data-img="${esc(w.image)}"`} />`
    : "";

  const media = isRule ? "" :
    `<a class="tag-btn" href="${reversoUrl(w.word)}" target="_blank" rel="noopener" title="Примеры в контексте">📚 Примеры</a>
     <a class="tag-btn" href="${youglishUrl(w.word)}" target="_blank" rel="noopener" title="Произношение из видео">🗣 YouGlish</a>`;

  const editBtns = ui.editMode
    ? `<button class="tag-btn tag-btn--edit" data-act="edit">✏️ Правка</button>
       <button class="tag-btn tag-btn--del" data-act="delete">🗑</button>`
    : "";

  const actions = media || editBtns ? `<div class="card__actions">${media}${editBtns}</div>` : "";

  return `
    <article class="card card--${cat} ${learnedCls}" data-id="${w.id}">
      <button class="card__check" data-act="learned" title="Отметить как выученное" aria-pressed="${w.learned}">${w.learned ? "✓" : ""}</button>
      <div class="card__body">
        ${head}
        ${meaning}
        ${example}
        ${image}
      </div>
      ${actions}
    </article>`;
}

function renderVocab() {
  const list = visibleWords();
  grid.innerHTML = list.map(cardHtml).join("");
  empty.classList.toggle("hidden", list.length > 0);

  // Подгрузить картинки правил из приватного репо
  grid.querySelectorAll("img[data-img]").forEach((img) =>
    resolveAsset(img, GITHUB.dirs.images, img.dataset.img, "image/*"));

  // прогресс — по текущей вкладке
  const inSection = getWords().filter((w) => (w.category || "word") === ui.section);
  const learned = inSection.filter((w) => w.learned).length;
  const total = inSection.length;
  $("#progress-text").textContent = `${learned} / ${total}`;
  $("#progress-fill").style.width = (total ? Math.round((learned / total) * 100) : 0) + "%";
}

// ── Раздел «Песни» ───────────────────────────────────────────────────
function songCardHtml(s) {
  const editBtns = ui.editMode
    ? `<div class="card__actions" style="margin-left:auto">
         <button class="tag-btn tag-btn--edit" data-act="edit-song">✏️</button>
         <button class="tag-btn tag-btn--del" data-act="del-song">🗑</button>
       </div>` : "";
  return `
    <div class="song-card" data-id="${s.id}" data-act="open-song">
      <div class="song-card__disc">🎵</div>
      <div class="song-card__meta">
        <h3 class="song-card__title">${esc(s.title)}</h3>
        <p class="song-card__artist">${esc(s.artist || "—")}</p>
      </div>
      ${editBtns}
    </div>`;
}

function songViewHtml(s) {
  const lines = (s.lyrics || []).map((l) => {
    const emptyLine = !l.it && !l.ru;
    return `<div class="lyric-line ${emptyLine ? "is-empty" : ""}">
        <div class="lyric-it">${esc(l.it || "")}</div>
        <div class="lyric-ru">${esc(l.ru || "")}</div>
      </div>`;
  }).join("");

  const player = s.audio
    ? `<div class="player"><audio id="song-audio" controls preload="none"></audio></div>`
    : `<div class="player"><p class="player__hint">🔇 Аудио не задано. Добавь mp3 в режиме ✏️.</p></div>`;

  const noTokenHint = s.audio && !isUrl(s.audio) && !isConfigured()
    ? `<p class="player__hint">Чтобы слушать mp3 из приватного репо — открой ☁️ и вставь токен.</p>` : "";

  return `
    <div class="song-view__top">
      <button class="song-back" data-act="close-song">← Все песни</button>
    </div>
    <div class="song-view__head">
      <h2 class="song-view__title">${esc(s.title)}</h2>
      <p class="song-view__artist">${esc(s.artist || "")}</p>
    </div>
    ${player}
    ${noTokenHint}
    <div class="lyrics">${lines || '<p class="empty">Текст ещё не добавлен.</p>'}</div>`;
}

function renderSongs() {
  const listEl = $("#songs-list");
  const viewEl = $("#song-view");
  const song = ui.openSongId ? getSongs().find((s) => s.id === ui.openSongId) : null;

  if (song) {
    listEl.classList.add("hidden");
    viewEl.classList.remove("hidden");
    viewEl.innerHTML = songViewHtml(song);
    empty.classList.add("hidden");
    // подгрузить аудио
    const audio = $("#song-audio", viewEl);
    if (audio && song.audio) resolveAsset(audio, GITHUB.dirs.audio, song.audio, "audio/mpeg");
  } else {
    viewEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    const songs = getSongs();
    listEl.innerHTML = songs.map(songCardHtml).join("");
    empty.classList.toggle("hidden", songs.length > 0);
  }
}

// ── Общий рендер ─────────────────────────────────────────────────────
function updateCounts() {
  const counts = {};
  getWords().forEach((w) => { const c = w.category || "word"; counts[c] = (counts[c] || 0) + 1; });
  counts.song = getSongs().length;
  document.querySelectorAll(".tab__count").forEach((el) => {
    el.textContent = counts[el.dataset.count] || 0;
  });
}

function render() {
  const isSong = ui.section === "song";
  $("#vocab-tools").classList.toggle("hidden", isSong);
  grid.classList.toggle("hidden", isSong);
  $("#songs").classList.toggle("hidden", !isSong);

  if (isSong) renderSongs();
  else renderVocab();

  updateCounts();
  document.body.classList.toggle("edit-mode", ui.editMode);
}

// ── Клики по сетке слов ──────────────────────────────────────────────
grid.addEventListener("click", (e) => {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const id = e.target.closest(".card").dataset.id;
  const act = actEl.dataset.act;
  if (act === "learned") toggleLearned(id);
  else if (act === "speak") speak(getWords().find((w) => w.id === id).word);
  else if (act === "edit") openWordDialog(id);
  else if (act === "delete") { if (confirm("Удалить эту карточку?")) deleteWord(id); }
});

// ── Клики в разделе песен ────────────────────────────────────────────
$("#songs").addEventListener("click", (e) => {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const act = actEl.dataset.act;
  const cardEl = e.target.closest("[data-id]");
  const id = cardEl ? cardEl.dataset.id : ui.openSongId;

  if (act === "open-song") { ui.openSongId = id; render(); window.scrollTo({ top: 0 }); }
  else if (act === "close-song") { ui.openSongId = null; render(); }
  else if (act === "edit-song") { e.stopPropagation(); openSongDialog(id); }
  else if (act === "del-song") { e.stopPropagation(); if (confirm("Удалить песню?")) { if (ui.openSongId === id) ui.openSongId = null; deleteSong(id); } }
});

// ── Диалог слова / связки / правила ─────────────────────────────────
const wordDialog = $("#word-dialog");
const wordForm = $("#word-form");
let editingId = null;

function configureWordDialog(category) {
  const isRule = category === "rule";
  wordForm.word.closest(".field").querySelector("span").textContent =
    isRule ? "Текст правила" : "Слово / фраза (по-итальянски)";
  wordForm.meaning.closest(".field").querySelector("span").textContent =
    isRule ? "Пояснение (необязательно)" : "Перевод / значение / ассоциация";
  wordForm.example.closest(".field").hidden = isRule;
  wordForm.exampleRu.closest(".field").hidden = isRule;
  $("#field-image").hidden = !isRule;
}

function openWordDialog(id = null) {
  editingId = id;
  const title = $("#word-dialog-title");
  const category = id ? (getWords().find((x) => x.id === id).category || "word") : ui.section;
  configureWordDialog(category);

  if (id) {
    const w = getWords().find((x) => x.id === id);
    title.textContent = "Редактировать";
    wordForm.word.value = w.word;
    wordForm.meaning.value = w.meaning || "";
    wordForm.example.value = w.example || "";
    wordForm.exampleRu.value = w.exampleRu || "";
    wordForm.image.value = w.image || "";
  } else {
    title.textContent = "Добавить " + (SECTION_LABEL[category] || "запись");
    wordForm.reset();
  }
  wordDialog.showModal();
}

wordForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const data = {
    word: wordForm.word.value.trim(),
    meaning: wordForm.meaning.value.trim(),
    example: wordForm.example.value.trim(),
    exampleRu: wordForm.exampleRu.value.trim(),
    image: wordForm.image.value.trim(),
  };
  if (!data.word) return;
  if (editingId) updateWord(editingId, data);
  else addWord({ ...data, category: ui.section });
  wordDialog.close();
  toast(editingId ? "Сохранено" : "Добавлено", "ok");
});

// ── Диалог песни ─────────────────────────────────────────────────────
const songDialog = $("#song-dialog");
const songForm = $("#song-form");
let editingSongId = null;

function openSongDialog(id = null) {
  editingSongId = id;
  const title = $("#song-dialog-title");
  if (id) {
    const s = getSongs().find((x) => x.id === id);
    title.textContent = "Редактировать песню";
    songForm.title.value = s.title;
    songForm.artist.value = s.artist || "";
    songForm.audio.value = s.audio || "";
    songForm.lyricsIt.value = (s.lyrics || []).map((l) => l.it).join("\n");
    songForm.lyricsRu.value = (s.lyrics || []).map((l) => l.ru).join("\n");
  } else {
    title.textContent = "Новая песня";
    songForm.reset();
  }
  songDialog.showModal();
}

songForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const it = songForm.lyricsIt.value.split("\n");
  const ru = songForm.lyricsRu.value.split("\n");
  const n = Math.max(it.length, ru.length);
  const lyrics = [];
  for (let i = 0; i < n; i++) lyrics.push({ it: (it[i] || "").trim(), ru: (ru[i] || "").trim() });

  const data = {
    title: songForm.title.value.trim(),
    artist: songForm.artist.value.trim(),
    audio: songForm.audio.value.trim(),
    lyrics,
  };
  if (!data.title) return;
  if (editingSongId) updateSong(editingSongId, data);
  else addSong(data);
  songDialog.close();
  toast(editingSongId ? "Песня сохранена" : "Песня добавлена", "ok");
});

// ── Синхронизация с GitHub ───────────────────────────────────────────
const syncDialog = $("#sync-dialog");

function refreshSyncStatus() {
  const el = $("#sync-status");
  if (isConfigured()) {
    const last = localStorage.getItem(KEYS.lastSync);
    el.textContent = last
      ? `Подключено. Последняя синхр.: ${new Date(+last).toLocaleString("ru")}`
      : "Токен задан. Можно синхронизировать.";
    el.className = "muted ok-text";
  } else if (getToken()) {
    el.textContent = "Токен задан, но owner репозитория ещё не прописан в config.js.";
    el.className = "muted";
  } else {
    el.textContent = "Токен не задан — работаешь локально.";
    el.className = "muted";
  }
}

$("#btn-save-token").addEventListener("click", async () => {
  const val = $("#token-input").value.trim();
  setToken(val);
  refreshSyncStatus();
  if (!val) { toast("Токен удалён", "warn"); return; }
  if (!/^github_pat_|^ghp_/.test(val)) { toast("Похоже, это не токен (нужен github_pat_…)", "err"); return; }
  try { toast("Проверяю доступ…"); await checkAccess(); toast("Токен сохранён, доступ есть ✓", "ok"); }
  catch (err) { toast(err.message, "err"); }
});

$("#btn-pull").addEventListener("click", async () => {
  try {
    toast("Загружаю из GitHub…");
    const [{ words }, { songs }] = await Promise.all([pullWords(), pullSongs()]);
    if (words) setWords(words);
    if (songs) setSongs(songs);
    if (!words && !songs) { await checkAccess(); toast("Репозиторий доступен, но файлов данных в нём пока нет", "warn"); }
    else toast(`Загружено: ${words ? words.length : 0} слов, ${songs ? songs.length : 0} песен`, "ok");
    render();
    refreshSyncStatus();
  } catch (err) { toast(err.message, "err"); }
});

$("#btn-push").addEventListener("click", async () => {
  try {
    toast("Отправляю в GitHub…");
    await Promise.all([pushWords(getWords(), "Update words from app"), pushSongs(getSongs(), "Update songs from app")]);
    toast("Отправлено в GitHub", "ok");
    refreshSyncStatus();
  } catch (err) { toast("Ошибка отправки: " + err.message, "err"); }
});

// Индикатор автосохранения (снизу слева)
let hideStatusTimer = null;
function setSyncStatus(state) {
  const el = $("#sync-indicator");
  clearTimeout(hideStatusTimer);
  if (state === "saving") { el.className = "sync-indicator is-visible"; el.innerHTML = `<span class="spinner"></span><span>Сохраняю…</span>`; }
  else if (state === "saved") { el.className = "sync-indicator is-visible is-saved"; el.innerHTML = `<span class="sync-ic">✓</span><span>Сохранено</span>`; hideStatusTimer = setTimeout(() => (el.className = "sync-indicator"), 2200); }
  else if (state === "error") { el.className = "sync-indicator is-visible is-error"; el.innerHTML = `<span class="sync-ic">⚠</span><span>Не сохранено</span>`; }
  else el.className = "sync-indicator";
}

// Автосохранение обоих файлов (с задержкой), если настроено
let pushTimer = null;
function scheduleAutoPush() {
  if (!isConfigured()) return;
  clearTimeout(pushTimer);
  setSyncStatus("saving");
  pushTimer = setTimeout(async () => {
    try {
      await Promise.all([pushWords(getWords(), "Auto-sync from app"), pushSongs(getSongs(), "Auto-sync from app")]);
      refreshSyncStatus();
      setSyncStatus("saved");
    } catch (err) { console.warn("auto-push failed:", err.message); setSyncStatus("error"); }
  }, 4000);
}

// ── Тулбар / фильтры / вкладки / тема ────────────────────────────────
$("#search").addEventListener("input", (e) => { ui.query = e.target.value; render(); });

$("#filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  ui.filter = chip.dataset.filter;
  [...$("#filters").children].forEach((c) => c.classList.toggle("is-active", c === chip));
  render();
});

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  ui.section = tab.dataset.section;
  ui.openSongId = null;
  [...$("#tabs").children].forEach((t) => t.classList.toggle("is-active", t === tab));
  render();
});

$("#btn-edit").addEventListener("click", () => {
  ui.editMode = !ui.editMode;
  $("#btn-edit").classList.toggle("is-on", ui.editMode);
  render();
});

$("#btn-add").addEventListener("click", () => {
  if (ui.section === "song") openSongDialog(null);
  else openWordDialog(null);
});

$("#btn-sync").addEventListener("click", () => {
  $("#token-input").value = getToken();
  refreshSyncStatus();
  syncDialog.showModal();
});

document.querySelectorAll("[data-close]").forEach((b) =>
  b.addEventListener("click", (e) => e.target.closest("dialog").close()));

// Тема (дефолт — тёмная)
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $("#btn-theme").textContent = theme === "dark" ? "☀️" : "🌙";
  document.querySelector('meta[name="theme-color"]').setAttribute("content", theme === "dark" ? "#0b0d12" : "#f4f6fb");
  localStorage.setItem(KEYS.theme, theme);
}
$("#btn-theme").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

// ── Инициализация ────────────────────────────────────────────────────
async function init() {
  applyTheme(localStorage.getItem(KEYS.theme) || "dark");
  await loadInitial();
  subscribe(() => { render(); scheduleAutoPush(); });
  render();
  refreshSyncStatus();
}
init();
