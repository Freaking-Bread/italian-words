// Интерфейс: рендер слов и песен, редактирование, синхронизация, тема.
import { KEYS, GITHUB } from "./config.js";
import {
  loadInitial, subscribe,
  getWords, setWords, addWord, updateWord, deleteWord, toggleLearned,
  getSongs, setSongs, addSong, updateSong, deleteSong,
  getTexts, setTexts, addText, updateText, deleteText,
} from "./store.js";
import {
  pullWords, pullSongs, pullTexts, pushWords, pushSongs, pushTexts,
  getToken, setToken, isConfigured, checkAccess, assetUrl,
} from "./github.js";
import {
  play as playSong, toggle as togglePlay, next as nextSong, prev as prevSong,
  playRandom, setLoop, setShuffle, seekTo, onPlayerChange, playerState,
  currentSong, audioEl, hues, fmtTime,
} from "./player.js";

// Иконка из спрайта
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#ic-${name}"/></svg>`;

const SECTION_LABEL = { word: "слово", linker: "связку", rule: "правило", swear: "ругательство", song: "песню", text: "текст" };

// ── Состояние интерфейса ─────────────────────────────────────────────
const ui = { section: "word", filter: "learning", query: "", editMode: false, openSongId: null, openTextId: null };

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

// 1 строка / 2 строки / 5 строк
function plural(n, one, few, many) {
  const n10 = n % 10, n100 = n % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
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

// Озвучить произвольный текст целиком (для вкладки «Тексты»).
function speakText(text) {
  if (!("speechSynthesis" in window) || !text) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "it-IT";
  u.rate = 0.95;
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
  const isSwear = ui.section === "swear";
  return getWords().filter((w) => {
    if ((w.category || "word") !== ui.section) return false;
    if (!isSwear && ui.filter === "learned" && !w.learned) return false;   // у мата нет «выучил»
    if (!isSwear && ui.filter === "learning" && w.learned) return false;
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
  const isSwear = cat === "swear";
  const learnedCls = !isSwear && w.learned ? "is-learned" : "";

  const head = isRule
    ? `<p class="card__rule">${esc(w.word)}</p>`
    : `<div class="card__word-row">
         <h3 class="card__word">${esc(w.word)}</h3>
         <button class="mini-btn" data-act="speak" title="Произнести" aria-label="Произнести">${icon("speak")}</button>
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
    `<a class="tag-btn" href="${reversoUrl(w.word)}" target="_blank" rel="noopener" title="Примеры в контексте">${icon("book")} Примеры</a>
     <a class="tag-btn" href="${youglishUrl(w.word)}" target="_blank" rel="noopener" title="Произношение из видео">${icon("ext")} YouGlish</a>`;

  const editBtns = ui.editMode
    ? `<button class="tag-btn tag-btn--edit" data-act="edit">${icon("pencil")} Правка</button>
       <button class="tag-btn tag-btn--del" data-act="delete" aria-label="Удалить">${icon("trash")}</button>`
    : "";

  const actions = media || editBtns ? `<div class="card__actions">${media}${editBtns}</div>` : "";

  const check = isSwear ? "" :
    `<button class="card__check" data-act="learned" title="Отметить как выученное" aria-pressed="${w.learned}">${w.learned ? icon("check") : ""}</button>`;

  return `
    <article class="card card--${cat} ${learnedCls}" data-id="${w.id}">
      ${check}
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

// Стиль «обложки» — два оттенка, выведенные из названия песни.
function artStyle(s) {
  const { h1, h2 } = hues(s.title + (s.artist || ""));
  return `--h1:${h1};--h2:${h2}`;
}

function songCardHtml(s) {
  const playing = playerState().id === s.id;
  const editBtns = ui.editMode
    ? `<div class="song-card__tools">
         <button class="tag-btn tag-btn--edit" data-act="edit-song" aria-label="Правка">${icon("pencil")}</button>
         <button class="tag-btn tag-btn--del" data-act="del-song" aria-label="Удалить">${icon("trash")}</button>
       </div>` : "";
  const lineCount = (s.lyrics || []).filter((l) => l.it).length;
  const lineWord = plural(lineCount, "строка", "строки", "строк");
  return `
    <div class="song-card ${playing ? "is-playing" : ""}" data-id="${s.id}" data-act="open-song">
      ${editBtns}
      <div class="song-card__art" style="${artStyle(s)}">
        ${icon("note")}
        ${s.audio ? `<button class="song-card__play" data-act="play-song" aria-label="Слушать">${icon(playing && playerState().playing ? "pause" : "play")}</button>` : ""}
      </div>
      <div class="song-card__meta">
        <h3 class="song-card__title">${esc(s.title)}</h3>
        <p class="song-card__artist">${esc(s.artist || "—")}</p>
        <p class="song-card__badge">${icon("scroll")} ${lineCount} ${lineWord}</p>
      </div>
    </div>`;
}

// Разбить построчный текст на куплеты: пустая строка = граница куплета.
function toStanzas(lyrics = []) {
  const stanzas = [];
  let cur = { it: [], ru: [] };
  for (const l of lyrics) {
    if (!l.it && !l.ru) {
      if (cur.it.length || cur.ru.length) stanzas.push(cur);
      cur = { it: [], ru: [] };
      continue;
    }
    if (l.it) cur.it.push(l.it);
    if (l.ru) cur.ru.push(l.ru);
  }
  if (cur.it.length || cur.ru.length) stanzas.push(cur);
  return stanzas;
}

// Итальянский текст → слова в <span>, чтобы по ним можно было кликнуть.
function clickableWords(text) {
  return esc(text).replace(/[A-Za-zÀ-ÿ’']+/g, (w) => `<span class="w">${w}</span>`);
}

function songViewHtml(s) {
  const stanzas = toStanzas(s.lyrics).map((st) => `
    <div class="stanza">
      <p class="stanza__it">${st.it.map((l) => `<span class="ln">${clickableWords(l)}</span>`).join("")}</p>
      <p class="stanza__ru" lang="ru">${st.ru.map((l) => `<span class="ln">${esc(l)}</span>`).join("")}</p>
    </div>`).join("");

  const st = playerState();
  const isThis = st.id === s.id;
  const playLabel = isThis && st.playing ? "Пауза" : "Слушать";

  const playBtn = s.audio
    ? `<button class="btn-play" data-act="play-song">${icon(isThis && st.playing ? "pause" : "play")} ${playLabel}</button>`
    : "";
  const randomBtn = `<button class="back-btn" data-act="random-song">${icon("shuffle")} Случайная песня</button>`;

  let note = "";
  if (!s.audio) note = `<p class="player-note">Без аудио</p>`;
  else if (!isUrl(s.audio) && !isConfigured()) note = `<p class="player-note">Нужен токен, чтобы слушать</p>`;

  return `
    <div class="view-top">
      <button class="back-btn" data-act="close-song">${icon("back")} Все песни</button>
    </div>
    <div class="song-hero">
      <div class="song-hero__art" style="${artStyle(s)}">${icon("note")}</div>
      <div class="song-hero__meta">
        <p class="song-hero__kicker">Песня</p>
        <h2 class="song-hero__title">${esc(s.title)}</h2>
        <p class="song-hero__artist">${esc(s.artist || "")}</p>
        <div class="song-hero__actions">${playBtn}${randomBtn}</div>
      </div>
    </div>
    ${note}
    <div class="stanzas">${stanzas || '<p class="empty">Текст ещё не добавлен.</p>'}</div>`;
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
  } else {
    viewEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    const songs = getSongs();
    listEl.innerHTML = songs.map(songCardHtml).join("");
    empty.classList.toggle("hidden", songs.length > 0);
  }
}

// ── Раздел «Тексты» ──────────────────────────────────────────────────
function textCardHtml(t) {
  const preview = (t.body || "").replace(/\n+/g, " ").slice(0, 90);
  const editBtns = ui.editMode
    ? `<div class="card__actions" style="margin-left:auto">
         <button class="tag-btn tag-btn--edit" data-act="edit-text" aria-label="Правка">${icon("pencil")}</button>
         <button class="tag-btn tag-btn--del" data-act="del-text" aria-label="Удалить">${icon("trash")}</button>
       </div>` : "";
  return `
    <div class="text-card" data-id="${t.id}" data-act="open-text">
      <div class="text-card__icon">📜</div>
      <div class="text-card__meta">
        <h3 class="text-card__title">${esc(t.title)}</h3>
        <p class="text-card__preview">${esc(preview)}${(t.body || "").length > 90 ? "…" : ""}</p>
      </div>
      ${editBtns}
    </div>`;
}

// Тело текста → абзацы (пустая строка = новый абзац, перевод строки = <br>)
function bodyToHtml(body = "") {
  return body.split(/\n{2,}/).map((par) =>
    `<p class="text-par">${par.split("\n").map(esc).join("<br>")}</p>`
  ).join("");
}

function textViewHtml(t) {
  return `
    <div class="view-top">
      <button class="back-btn" data-act="close-text">${icon("back")} Все тексты</button>
      <button class="back-btn" data-act="speak-text" title="Озвучить">${icon("speak")} Озвучить</button>
    </div>
    <h2 class="text-view__title">${esc(t.title)}</h2>
    <div class="text-body">${bodyToHtml(t.body) || '<p class="empty">Текст пуст.</p>'}</div>`;
}

function renderTexts() {
  const listEl = $("#texts-list");
  const viewEl = $("#text-view");
  const text = ui.openTextId ? getTexts().find((t) => t.id === ui.openTextId) : null;

  if (text) {
    listEl.classList.add("hidden");
    viewEl.classList.remove("hidden");
    viewEl.innerHTML = textViewHtml(text);
    empty.classList.add("hidden");
  } else {
    viewEl.classList.add("hidden");
    listEl.classList.remove("hidden");
    const texts = getTexts();
    listEl.innerHTML = texts.map(textCardHtml).join("");
    empty.classList.toggle("hidden", texts.length > 0);
  }
}

// ── Общий рендер ─────────────────────────────────────────────────────
function updateCounts() {
  const counts = {};
  getWords().forEach((w) => { const c = w.category || "word"; counts[c] = (counts[c] || 0) + 1; });
  counts.song = getSongs().length;
  counts.text = getTexts().length;
  document.querySelectorAll(".tab__count").forEach((el) => {
    el.textContent = counts[el.dataset.count] || 0;
  });
}

function render() {
  const isSong = ui.section === "song";
  const isText = ui.section === "text";
  const isSwear = ui.section === "swear";
  const isVocab = !isSong && !isText;      // словарная сетка: слова/связки/правила/мат
  $("#vocab-tools").classList.toggle("hidden", !isVocab);
  grid.classList.toggle("hidden", !isVocab);
  $("#songs").classList.toggle("hidden", !isSong);
  $("#texts").classList.toggle("hidden", !isText);
  // у мата нет прогресса и фильтра «выучил» — только поиск
  $(".progress").classList.toggle("hidden", !isVocab || isSwear);
  $("#filters").classList.toggle("hidden", isSwear);

  if (isSong) renderSongs();
  else if (isText) renderTexts();
  else renderVocab();

  updateCounts();
  closeWordPop();
  document.body.classList.toggle("edit-mode", ui.editMode);
  document.body.classList.toggle("song-open", isSong);
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
  // клик по слову в тексте песни → поповер «в словарь»
  const wordEl = e.target.closest(".w");
  if (wordEl) { openWordPop(wordEl); return; }

  const actEl = e.target.closest("[data-act]");
  if (!actEl) { closeWordPop(); return; }
  const act = actEl.dataset.act;
  const cardEl = e.target.closest("[data-id]");
  const id = cardEl ? cardEl.dataset.id : ui.openSongId;

  if (act === "open-song") { ui.openSongId = id; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
  else if (act === "close-song") { ui.openSongId = null; render(); }
  else if (act === "play-song") { e.stopPropagation(); playSong(id); }
  else if (act === "random-song") {
    const s = playRandom();
    if (s) { ui.openSongId = s.id; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else toast("Нет ни одной песни с mp3", "warn");
  }
  else if (act === "edit-song") { e.stopPropagation(); openSongDialog(id); }
  else if (act === "del-song") { e.stopPropagation(); if (confirm("Удалить песню?")) { if (ui.openSongId === id) ui.openSongId = null; deleteSong(id); } }
});

// ── Клики в разделе текстов ──────────────────────────────────────────
$("#texts").addEventListener("click", (e) => {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const act = actEl.dataset.act;
  const cardEl = e.target.closest("[data-id]");
  const id = cardEl ? cardEl.dataset.id : ui.openTextId;

  if (act === "open-text") { ui.openTextId = id; render(); window.scrollTo({ top: 0 }); }
  else if (act === "close-text") { speechSynthesis.cancel(); ui.openTextId = null; render(); }
  else if (act === "speak-text") { const t = getTexts().find((x) => x.id === ui.openTextId); if (t) speakText(t.body); }
  else if (act === "edit-text") { e.stopPropagation(); openTextDialog(id); }
  else if (act === "del-text") { e.stopPropagation(); if (confirm("Удалить текст?")) { if (ui.openTextId === id) ui.openTextId = null; deleteText(id); } }
});

// ── Диалог слова / связки / правила ─────────────────────────────────
const wordDialog = $("#word-dialog");
const wordForm = $("#word-form");
let editingId = null;
// Куда класть новую карточку, если открыли диалог не со «словарной» вкладки
// (например, кликнув по слову в тексте песни).
let pendingCategory = null;

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
  pendingCategory = null;
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
  else addWord({ ...data, category: pendingCategory || ui.section });
  const wasFromSong = pendingCategory && ui.section === "song";
  pendingCategory = null;
  wordDialog.close();
  toast(editingId ? "Сохранено" : wasFromSong ? `«${data.word}» → в словарь` : "Добавлено", "ok");
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

// ── Диалог текста ────────────────────────────────────────────────────
const textDialog = $("#text-dialog");
const textForm = $("#text-form");
let editingTextId = null;

function openTextDialog(id = null) {
  editingTextId = id;
  const title = $("#text-dialog-title");
  if (id) {
    const t = getTexts().find((x) => x.id === id);
    title.textContent = "Редактировать текст";
    textForm.title.value = t.title;
    textForm.body.value = t.body || "";
  } else {
    title.textContent = "Новый текст";
    textForm.reset();
  }
  textDialog.showModal();
}

textForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const data = { title: textForm.title.value.trim(), body: textForm.body.value.trim() };
  if (!data.title) return;
  if (editingTextId) updateText(editingTextId, data);
  else addText(data);
  textDialog.close();
  toast(editingTextId ? "Текст сохранён" : "Текст добавлен", "ok");
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
    const [{ words }, { songs }, { texts }] = await Promise.all([pullWords(), pullSongs(), pullTexts()]);
    if (words) setWords(words);
    if (songs) setSongs(songs);
    if (texts) setTexts(texts);
    if (!words && !songs && !texts) { await checkAccess(); toast("Репозиторий доступен, но файлов данных в нём пока нет", "warn"); }
    else toast(`Загружено: ${words ? words.length : 0} слов, ${songs ? songs.length : 0} песен, ${texts ? texts.length : 0} текстов`, "ok");
    render();
    refreshSyncStatus();
  } catch (err) { toast(err.message, "err"); }
});

$("#btn-push").addEventListener("click", async () => {
  try {
    toast("Отправляю в GitHub…");
    await Promise.all([
      pushWords(getWords(), "Update words from app"),
      pushSongs(getSongs(), "Update songs from app"),
      pushTexts(getTexts(), "Update texts from app"),
    ]);
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
      await Promise.all([
        pushWords(getWords(), "Auto-sync from app"),
        pushSongs(getSongs(), "Auto-sync from app"),
        pushTexts(getTexts(), "Auto-sync from app"),
      ]);
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
  ui.openTextId = null;
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
  else if (ui.section === "text") openTextDialog(null);
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
  $("#btn-theme").innerHTML = icon(theme === "dark" ? "sun" : "moon");
  document.querySelector('meta[name="theme-color"]').setAttribute("content", theme === "dark" ? "#08090c" : "#f6f7fb");
  localStorage.setItem(KEYS.theme, theme);
}
$("#btn-theme").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

// ── Нижний плеер ─────────────────────────────────────────────────────
const pb = $("#playerbar");
const seekEl = $("#pb-seek");
let seeking = false;

function renderPlayerbar() {
  const st = playerState();
  const song = currentSong();

  pb.classList.toggle("is-hidden", !song);
  document.body.classList.toggle("has-player", !!song);
  document.body.classList.toggle("is-playing", st.playing);
  if (!song) return;

  $("#pb-title").textContent = song.title;
  $("#pb-artist").textContent = song.artist || "";
  const { h1, h2 } = hues(song.title + (song.artist || ""));
  const art = pb.querySelector(".playerbar__art");
  art.style.setProperty("--h1", h1);
  art.style.setProperty("--h2", h2);

  pb.querySelector('[data-p="play"]').innerHTML = icon(st.playing ? "pause" : "play");
  pb.querySelector('[data-p="loop"]').classList.toggle("is-on", st.loop);
  pb.querySelector('[data-p="shuffle"]').classList.toggle("is-on", st.shuffle);

  if (st.error && st.error !== renderPlayerbar._lastError) toast(st.error, "err");
  renderPlayerbar._lastError = st.error;
}

pb.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-p]");
  if (btn) {
    const act = btn.dataset.p;
    if (act === "play") togglePlay();
    else if (act === "next") nextSong(true);
    else if (act === "prev") prevSong();
    else if (act === "loop") setLoop(!playerState().loop);
    else if (act === "shuffle") {
      const on = !playerState().shuffle;
      setShuffle(on);
      toast(on ? "Дальше пойдёт случайная песня" : "Дальше — по списку");
    }
    return;
  }
  // тап по названию — открыть страницу песни
  if (e.target.closest("#pb-meta")) {
    const song = currentSong();
    if (!song) return;
    ui.section = "song";
    ui.openSongId = song.id;
    [...$("#tabs").children].forEach((t) => t.classList.toggle("is-active", t.dataset.section === "song"));
    render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
});

const audio = audioEl();
audio.addEventListener("timeupdate", () => {
  if (seeking || !audio.duration) return;
  const pct = (audio.currentTime / audio.duration) * 100;
  seekEl.value = Math.round(pct * 10);
  seekEl.style.backgroundSize = pct + "% 100%";
  $("#pb-cur").textContent = fmtTime(audio.currentTime);
});
audio.addEventListener("loadedmetadata", () => { $("#pb-dur").textContent = fmtTime(audio.duration); });
seekEl.addEventListener("input", () => {
  seeking = true;
  seekEl.style.backgroundSize = seekEl.value / 10 + "% 100%";
  if (audio.duration) $("#pb-cur").textContent = fmtTime((seekEl.value / 1000) * audio.duration);
});
seekEl.addEventListener("change", () => { seekTo(seekEl.value / 1000); seeking = false; });

// Пробел — играть/пауза (если не печатаем в поле)
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || !currentSong()) return;
  const t = e.target;
  if (t.matches("input, textarea, button") || t.isContentEditable) return;
  e.preventDefault();
  togglePlay();
});

// Плеер поменялся → обновить панель. Открытую песню целиком не перерисовываем,
// чтобы не сбивать прокрутку по тексту — меняем только кнопку.
onPlayerChange(() => {
  renderPlayerbar();
  if (ui.section !== "song") return;
  if (ui.openSongId) {
    const st = playerState();
    const btn = $("#song-view .btn-play");
    if (!btn) return;
    const isThis = st.id === ui.openSongId;
    btn.innerHTML = icon(isThis && st.playing ? "pause" : "play") + (isThis && st.playing ? " Пауза" : " Слушать");
  } else {
    renderSongs();
  }
});

// ── Поповер «слово → в словарь» ──────────────────────────────────────
const wordpop = $("#wordpop");
let pickedWord = "", pickedLine = "";

function openWordPop(el) {
  closeWordPop();
  el.classList.add("is-picked");
  pickedWord = el.textContent.trim();
  pickedLine = (el.closest(".ln") || el.closest(".stanza__it"))?.textContent.trim() || "";

  $("#wordpop-word").textContent = pickedWord;
  wordpop.classList.remove("is-hidden");

  // спозиционировать над словом, не вылезая за экран
  const r = el.getBoundingClientRect();
  const w = wordpop.offsetWidth;
  const left = Math.min(Math.max(10, r.left + r.width / 2 - w / 2), window.innerWidth - w - 10);
  let top = r.top - wordpop.offsetHeight - 10;
  if (top < 8) top = r.bottom + 10;
  wordpop.style.left = left + "px";
  wordpop.style.top = top + "px";
}

function closeWordPop() {
  wordpop.classList.add("is-hidden");
  document.querySelectorAll(".w.is-picked").forEach((el) => el.classList.remove("is-picked"));
}

$("#wordpop-speak").addEventListener("click", () => speak(pickedWord));
$("#wordpop-add").addEventListener("click", () => {
  const dup = getWords().find((w) => w.word.toLowerCase() === pickedWord.toLowerCase());
  if (dup) { toast(`«${pickedWord}» уже есть в словаре`, "warn"); closeWordPop(); return; }
  const song = currentSongInView();
  configureWordDialog("word");
  editingId = null;
  $("#word-dialog-title").textContent = "Слово из песни";
  wordForm.reset();
  wordForm.word.value = pickedWord;
  wordForm.example.value = pickedLine;
  pendingCategory = "word";
  wordDialog.showModal();
  wordForm.meaning.focus();
  closeWordPop();
  void song;
});

function currentSongInView() { return ui.openSongId ? getSongs().find((s) => s.id === ui.openSongId) : null; }

document.addEventListener("click", (e) => {
  if (!wordpop.classList.contains("is-hidden") && !e.target.closest("#wordpop") && !e.target.closest(".w")) closeWordPop();
});
window.addEventListener("scroll", closeWordPop, { passive: true });

// ── Инициализация ────────────────────────────────────────────────────
async function init() {
  applyTheme(localStorage.getItem(KEYS.theme) || "dark");
  await loadInitial();
  subscribe(() => { render(); scheduleAutoPush(); });
  render();
  renderPlayerbar();
  refreshSyncStatus();
}
init();
