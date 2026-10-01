// Интерфейс: рендер слов и песен, тренировка, редактирование, синхронизация, тема.
import { KEYS, GITHUB } from "./config.js";
import {
  COLLECTIONS, loadInitial, subscribe, getList, setList, mergeRemote, dirtyCollections, markPushed,
  getWords, addWord, updateWord, deleteWord, toggleLearned, setLearned,
  getSongs, addSong, updateSong, deleteSong,
  getTexts, addText, updateText, deleteText,
  getAssoc, addAssoc, updateAssoc, deleteAssoc,
} from "./store.js";
import {
  pullCollection, pushCollection, ConflictError,
  getToken, setToken, isConfigured, checkAccess, assetUrl,
} from "./github.js";
import {
  play as playSong, toggle as togglePlay, next as nextSong, prev as prevSong,
  playRandom, setLoop, setShuffle, seekTo, onPlayerChange, playerState,
  currentSong, audioEl, hues, fmtTime,
} from "./player.js";

// Иконка из спрайта
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#ic-${name}"/></svg>`;

const SECTION_LABEL = { word: "слово", linker: "связку", rule: "правило", swear: "ругательство", song: "песню", text: "текст", assoc: "ассоциацию" };

// Баннер каждого раздела: итальянский заголовок + фото
const SECTION = {
  word:   { title: "Le parole",       img: "word" },
  linker: { title: "I connettivi",    img: "linker" },
  rule:   { title: "Le regole",       img: "rule" },
  assoc:  { title: "Le associazioni", img: "assoc" },
  swear:  { title: "Le parolacce",    img: "swear" },
  song:   { title: "Le canzoni",      img: "song" },
  text:   { title: "I testi",         img: "text" },
};
const TRAINABLE = new Set(["word", "linker"]);

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

// ── Статистика: сколько выучено сегодня и сколько дней подряд ────────
// Считается по updatedAt выученных карточек — поэтому одинаково на всех
// устройствах, без отдельного хранилища.
const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

function activity() {
  const days = new Set();
  const today = dayKey(Date.now());
  let todayCount = 0;
  for (const w of getWords()) {
    if (!w.learned || !w.updatedAt) continue;
    const k = dayKey(w.updatedAt);
    days.add(k);
    if (k === today) todayCount++;
  }
  let streak = 0;
  const d = new Date();
  if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);   // сегодня ещё не занимался — серия не сгорела
  while (days.has(dayKey(d))) { streak++; d.setDate(d.getDate() - 1); }
  return { today: todayCount, streak };
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return "Buonanotte";
  if (h < 12) return "Buongiorno";
  if (h < 18) return "Buon pomeriggio";
  return "Buonasera";
}

// Слово дня — одно и то же весь день, из ещё не выученных
function wordOfDay() {
  const pool = getWords().filter((w) => (w.category || "word") === "word" && !w.learned && w.meaning);
  if (!pool.length) return null;
  let h = 0;
  for (const c of dayKey(Date.now())) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return pool[h % pool.length];
}

// ── Баннер раздела ───────────────────────────────────────────────────
const stat = (ic, html, cls = "") => `<span class="stat ${cls}">${icon(ic)}<span>${html}</span></span>`;

function renderHero() {
  const hero = $("#hero");
  const viewOpen = (ui.section === "song" && ui.openSongId) || (ui.section === "text" && ui.openTextId);
  hero.classList.toggle("hidden", !!viewOpen);
  if (viewOpen) return;

  const sec = SECTION[ui.section];
  hero.dataset.section = ui.section;
  const img = $("#hero-img");
  if (img.dataset.key !== sec.img) {
    img.dataset.key = sec.img;
    img.classList.remove("is-loaded");
    $("#hero-src-sm").srcset = `img/${sec.img}-sm.webp`;
    img.src = `img/${sec.img}.webp`;
  }

  $("#hero-kicker").textContent = `${greeting()}, Gleb`;
  $("#hero-title").textContent = sec.title;

  let stats = "", actions = "";
  const words = getWords();
  if (ui.section === "word" || ui.section === "linker") {
    const list = words.filter((w) => (w.category || "word") === ui.section);
    const learned = list.filter((w) => w.learned).length;
    const pct = list.length ? Math.round((learned / list.length) * 100) : 0;
    const { today, streak } = activity();
    stats = `
      <div class="hero__progress">
        <div class="hero__progress-row"><b>${learned}</b><span>из ${list.length} выучено</span><em>${pct}%</em></div>
        <div class="bar"><span style="width:${pct}%"></span></div>
      </div>
      <div class="hero__chips">
        ${streak ? stat("flame", `<b>${streak}</b> ${plural(streak, "день", "дня", "дней")} подряд`, "stat--hot") : ""}
        ${stat("spark", `<b>+${today}</b> сегодня`)}
      </div>`;
    if (TRAINABLE.has(ui.section) && list.some((w) => !w.learned)) {
      actions = `<button class="btn-hero" data-act="train">${icon("cards")} Тренировка</button>`;
    }
  } else if (ui.section === "rule") {
    const n = words.filter((w) => w.category === "rule").length;
    stats = `<div class="hero__chips">${stat("rule", `<b>${n}</b> ${plural(n, "правило", "правила", "правил")}`)}</div>`;
  } else if (ui.section === "swear") {
    const n = words.filter((w) => w.category === "swear").length;
    stats = `<div class="hero__chips">${stat("flame", `<b>${n}</b> ${plural(n, "выражение", "выражения", "выражений")}`)}</div>`;
  } else if (ui.section === "song") {
    const songs = getSongs();
    const lines = songs.reduce((a, s) => a + (s.lyrics || []).filter((l) => l.it).length, 0);
    stats = `<div class="hero__chips">${stat("note", `<b>${songs.length}</b> ${plural(songs.length, "песня", "песни", "песен")}`)}${stat("scroll", `<b>${lines}</b> ${plural(lines, "строка", "строки", "строк")}`)}</div>`;
    if (songs.some((s) => s.audio)) actions = `<button class="btn-hero btn-hero--warm" data-act="random-song">${icon("shuffle")} Случайная песня</button>`;
  } else if (ui.section === "text") {
    const n = getTexts().length;
    stats = `<div class="hero__chips">${stat("scroll", `<b>${n}</b> ${plural(n, "текст", "текста", "текстов")}`)}</div>`;
  } else if (ui.section === "assoc") {
    const n = getAssoc().length;
    stats = `<div class="hero__chips">${stat("image", `<b>${n}</b> ${plural(n, "лист", "листа", "листов")}`)}</div>`;
  }
  $("#hero-stats").innerHTML = stats;
  $("#hero-actions").innerHTML = actions;

  // Слово дня — только на «Словах»
  const wotdEl = $("#wotd");
  const w = ui.section === "word" ? wordOfDay() : null;
  wotdEl.classList.toggle("hidden", !w);
  if (w) {
    wotdEl.dataset.id = w.id;
    wotdEl.innerHTML = `
      <p class="wotd__kicker">Parola del giorno</p>
      <div class="wotd__row">
        <h3 class="wotd__word">${esc(w.word)}</h3>
        <button class="mini-btn" data-act="wotd-speak" aria-label="Произнести">${icon("speak")}</button>
      </div>
      <p class="wotd__meaning">${esc(w.meaning)}</p>
      ${w.example ? `<p class="wotd__ex">${esc(w.example)}</p>` : ""}`;
  }
}

$("#hero-img").addEventListener("load", (e) => e.target.classList.add("is-loaded"));
if ($("#hero-img").complete && $("#hero-img").naturalWidth) $("#hero-img").classList.add("is-loaded");

$("#hero").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "train") openTrainer(ui.section);
  else if (act === "random-song") {
    const s = playRandom();
    if (s) { ui.openSongId = s.id; render(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    else toast("Нет ни одной песни с mp3", "warn");
  }
  else if (act === "wotd-speak") {
    const w = getWords().find((x) => x.id === $("#wotd").dataset.id);
    if (w) speak(w.word);
  }
});

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
    ? `<img class="card__img" alt="" loading="lazy" ${isUrl(w.image) ? `src="${esc(w.image)}"` : `data-img="${esc(w.image)}"`} />`
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
    `<button class="card__check" data-act="learned" title="Отметить как выученное" aria-pressed="${!!w.learned}">${icon("check")}</button>`;

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

// Карточек может быть почти тысяча — рисуем порциями по мере прокрутки.
const PAGE = 48;
let vocabList = [];
let shown = 0;

function appendPage() {
  const next = vocabList.slice(shown, shown + PAGE);
  if (!next.length) return false;
  grid.insertAdjacentHTML("beforeend", next.map(cardHtml).join(""));
  shown += next.length;
  // картинки правил — из приватного репо
  grid.querySelectorAll("img[data-img]:not([src])").forEach((img) =>
    resolveAsset(img, GITHUB.dirs.images, img.dataset.img, "image/*"));
  return true;
}

function fillViewport() {
  const more = $("#more");
  while (shown < vocabList.length && more.getBoundingClientRect().top < window.innerHeight + 900) {
    if (!appendPage()) break;
  }
}

new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && !grid.classList.contains("hidden")) fillViewport();
}, { rootMargin: "900px 0px" }).observe($("#more"));
// запасной путь: на некоторых браузерах observer срабатывает не всегда
let scrollTick = false;
window.addEventListener("scroll", () => {
  if (scrollTick || shown >= vocabList.length) return;
  scrollTick = true;
  setTimeout(() => { scrollTick = false; fillViewport(); }, 120);
}, { passive: true });

function renderVocab() {
  vocabList = visibleWords();
  shown = 0;
  grid.innerHTML = "";
  appendPage();
  setTimeout(fillViewport, 0);
  empty.classList.toggle("hidden", vocabList.length > 0);
}

// Галочка «выучил» — меняем одну карточку, а не перерисовываем сотни.
function onLearnedToggled(id) {
  const w = getWords().find((x) => x.id === id);
  const card = grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (!w || !card) return;
  card.classList.toggle("is-learned", w.learned);
  card.querySelector(".card__check")?.setAttribute("aria-pressed", String(w.learned));
  if (w.learned) card.classList.add("just-learned");

  const leaves = (ui.filter === "learning" && w.learned) || (ui.filter === "learned" && !w.learned);
  if (leaves) {
    card.classList.add("is-leaving");
    setTimeout(() => {
      card.remove();
      const i = vocabList.findIndex((x) => x.id === id);
      if (i >= 0) { vocabList.splice(i, 1); if (i < shown) shown--; }
      fillViewport();
      empty.classList.toggle("hidden", vocabList.length > 0);
    }, 280);
  }
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
        <span class="disc">${icon("note")}</span>
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
    <div class="song-hero" style="${artStyle(s)}">
      <div class="song-hero__art"><span class="disc">${icon("note")}</span></div>
      <div class="song-hero__meta">
        <p class="song-hero__kicker">Canzone</p>
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

// ── Раздел «Ассоциации» ──────────────────────────────────────────────
// Листы с картинками-подсказками: сетка превью → тап открывает во весь экран.
function assocCardHtml(a) {
  const editBtns = ui.editMode
    ? `<div class="assoc-card__tools">
         <button class="tag-btn tag-btn--edit" data-act="edit-assoc" aria-label="Правка">${icon("pencil")}</button>
         <button class="tag-btn tag-btn--del" data-act="del-assoc" aria-label="Удалить">${icon("trash")}</button>
       </div>` : "";
  const img = a.image
    ? `<img class="assoc-card__img" alt="${esc(a.title)}" loading="lazy" ${isUrl(a.image) ? `src="${esc(a.image)}"` : `data-img="${esc(a.image)}"`} />`
    : `<div class="assoc-card__ph">${icon("image")}</div>`;
  return `
    <figure class="assoc-card" data-id="${a.id}" data-act="open-assoc">
      ${editBtns}
      <div class="assoc-card__frame">${img}</div>
      <figcaption class="assoc-card__meta">
        <h3 class="assoc-card__title">${esc(a.title)}</h3>
        ${a.note ? `<p class="assoc-card__note">${esc(a.note)}</p>` : ""}
      </figcaption>
    </figure>`;
}

function visibleAssoc() {
  const q = ui.query.trim().toLowerCase();
  if (!q) return getAssoc();
  return getAssoc().filter((a) =>
    (a.title || "").toLowerCase().includes(q) || (a.note || "").toLowerCase().includes(q));
}

function renderAssoc() {
  const listEl = $("#assoc-list");
  const list = visibleAssoc();
  listEl.innerHTML = list.map(assocCardHtml).join("");
  // превью лежат в приватном репо — тянем их по токену
  listEl.querySelectorAll("img[data-img]").forEach((img) =>
    resolveAsset(img, GITHUB.dirs.images, img.dataset.img, "image/jpeg"));
  empty.classList.toggle("hidden", list.length > 0);
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
  counts.assoc = getAssoc().length;
  document.querySelectorAll(".tab__count").forEach((el) => {
    el.textContent = counts[el.dataset.count] || 0;
  });
}

function render() {
  const isSong = ui.section === "song";
  const isText = ui.section === "text";
  const isAssoc = ui.section === "assoc";
  const isSwear = ui.section === "swear";
  const isVocab = !isSong && !isText && !isAssoc;  // словарная сетка: слова/связки/правила/мат
  // ассоциациям из инструментов нужен только поиск
  $("#vocab-tools").classList.toggle("hidden", !isVocab && !isAssoc);
  grid.classList.toggle("hidden", !isVocab);
  $("#songs").classList.toggle("hidden", !isSong);
  $("#texts").classList.toggle("hidden", !isText);
  $("#assoc").classList.toggle("hidden", !isAssoc);
  // у мата и ассоциаций нет фильтра «выучил» — только поиск
  $("#filters").classList.toggle("hidden", isSwear || isAssoc);

  if (isSong) renderSongs();
  else if (isText) renderTexts();
  else if (isAssoc) renderAssoc();
  else renderVocab();
  if (!isVocab) { vocabList = []; shown = 0; grid.innerHTML = ""; }

  renderHero();
  updateCounts();
  closeWordPop();
  document.body.classList.toggle("edit-mode", ui.editMode);
  document.body.dataset.section = ui.section;
}

// ── Клики по сетке слов ──────────────────────────────────────────────
grid.addEventListener("click", (e) => {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const id = e.target.closest(".card").dataset.id;
  const act = actEl.dataset.act;
  if (act === "learned") { toggleLearned(id, { quiet: true }); onLearnedToggled(id); }
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

  if (act === "open-song") { ui.openSongId = id; render(); window.scrollTo({ top: 0 }); }
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

// ── Клики в разделе ассоциаций ───────────────────────────────────────
$("#assoc").addEventListener("click", (e) => {
  const actEl = e.target.closest("[data-act]");
  if (!actEl) return;
  const act = actEl.dataset.act;
  const id = e.target.closest("[data-id]").dataset.id;

  if (act === "open-assoc") openAssocViewer(id);
  else if (act === "edit-assoc") { e.stopPropagation(); openAssocDialog(id); }
  else if (act === "del-assoc") { e.stopPropagation(); if (confirm("Удалить эту картинку?")) deleteAssoc(id); }
});

// Картинка на весь экран
const assocViewer = $("#assoc-viewer");

function openAssocViewer(id) {
  const a = getAssoc().find((x) => x.id === id);
  if (!a) return;
  const imgEl = $("#assoc-viewer-img");
  imgEl.removeAttribute("src");
  imgEl.alt = a.title;
  $("#assoc-viewer-cap").textContent = a.note ? `${a.title} — ${a.note}` : a.title;
  if (a.image) resolveAsset(imgEl, GITHUB.dirs.images, a.image, "image/jpeg");
  assocViewer.showModal();
}

// тап по фону (не по самой картинке) закрывает просмотр
assocViewer.addEventListener("click", (e) => {
  if (!e.target.closest(".lightbox__img")) assocViewer.close();
});

// ── Диалог ассоциации ────────────────────────────────────────────────
const assocDialog = $("#assoc-dialog");
const assocForm = $("#assoc-form");
let editingAssocId = null;

function openAssocDialog(id = null) {
  editingAssocId = id;
  const title = $("#assoc-dialog-title");
  if (id) {
    const a = getAssoc().find((x) => x.id === id);
    title.textContent = "Редактировать ассоциацию";
    assocForm.title.value = a.title;
    assocForm.image.value = a.image || "";
    assocForm.note.value = a.note || "";
  } else {
    title.textContent = "Новая ассоциация";
    assocForm.reset();
  }
  assocDialog.showModal();
}

assocForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const data = {
    title: assocForm.title.value.trim(),
    image: assocForm.image.value.trim(),
    note: assocForm.note.value.trim(),
  };
  if (!data.title) return;
  if (editingAssocId) updateAssoc(editingAssocId, data);
  else addAssoc(data);
  assocDialog.close();
  toast(editingAssocId ? "Ассоциация сохранена" : "Ассоциация добавлена", "ok");
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

// ── Тренировка карточками ────────────────────────────────────────────
// Раунд из 20 невыученных карточек раздела. «Знаю» отмечает слово выученным,
// «Ещё учу» возвращает его в конец раунда — пока не ответишь «Знаю».
const trainer = $("#trainer");
const ROUND = 20;
const tr = { queue: [], total: 0, known: 0, flipped: false, reverse: false, section: "word" };

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

function openTrainer(section) {
  const pool = getWords().filter((w) => (w.category || "word") === section && !w.learned);
  if (!pool.length) { toast("Здесь всё выучено 🎉", "ok"); return; }
  tr.section = section;
  tr.queue = shuffle(pool.map((w) => w.id)).slice(0, ROUND);
  tr.total = tr.queue.length;
  tr.known = 0;
  tr.flipped = false;
  $("#tr-dir").textContent = tr.reverse ? "RU → IT" : "IT → RU";
  renderTrainer();
  trainer.showModal();
  $("#tr-stage .flash")?.focus();
}

function trainerCardHtml(w) {
  const it = `<h3 class="flash__word">${esc(w.word)}</h3>
              <button class="mini-btn flash__speak" data-act="tr-speak" aria-label="Произнести">${icon("speak")}</button>`;
  const ru = `<p class="flash__meaning">${esc(w.meaning || "—")}</p>`;
  const ex = w.example
    ? `<p class="flash__ex">${esc(w.example)}</p>${w.exampleRu ? `<p class="flash__ex-ru">${esc(w.exampleRu)}</p>` : ""}`
    : "";
  const front = tr.reverse ? ru : it;
  const back = tr.reverse ? `${it}${ex}` : `${ru}${ex}`;
  return `
    <div class="flash ${tr.flipped ? "is-flipped" : ""}" data-act="tr-flip" role="button" tabindex="0" aria-label="Перевернуть">
      <span class="flash__face flash__face--front">${front}<span class="flash__flip-ic">${icon("flip")}</span></span>
      <span class="flash__face flash__face--back">${back}</span>
    </div>`;
}

function renderTrainer() {
  const done = tr.total - tr.queue.length;
  $("#tr-count").textContent = `${Math.min(done + 1, tr.total)} / ${tr.total}`;
  $("#tr-fill").style.width = (tr.total ? (done / tr.total) * 100 : 0) + "%";
  const stage = $("#tr-stage");
  const actions = $("#tr-actions");

  if (!tr.queue.length) {
    $("#tr-count").textContent = `${tr.total} / ${tr.total}`;
    actions.classList.add("hidden");
    stage.innerHTML = `
      <div class="tr-done">
        <div class="tr-done__ic">${icon("trophy")}</div>
        <h3 class="tr-done__title">Bravissimo!</h3>
        <p class="tr-done__text">${tr.known} ${plural(tr.known, "слово", "слова", "слов")} в копилке</p>
        <div class="tr-done__actions">
          <button class="btn btn--primary" data-act="tr-again">Ещё раунд</button>
          <button class="btn btn--ghost" data-act="tr-close">Закрыть</button>
        </div>
      </div>`;
    return;
  }
  actions.classList.remove("hidden");
  const w = getWords().find((x) => x.id === tr.queue[0]);
  if (!w) { tr.queue.shift(); renderTrainer(); return; }
  stage.innerHTML = trainerCardHtml(w);
  stage.style.animation = "none"; void stage.offsetWidth; stage.style.animation = "";
  if (trainer.open) stage.querySelector(".flash").focus({ preventScroll: true });
}

function trainerAnswer(known) {
  const id = tr.queue.shift();
  if (!id) return;
  if (known) { tr.known++; setLearned(id, true, { quiet: true }); }
  else tr.queue.push(id);                 // вернётся в конце раунда
  tr.flipped = false;
  renderTrainer();
}

function flipCard() {
  const card = $("#tr-stage .flash");
  if (!card) return;
  tr.flipped = !tr.flipped;
  card.classList.toggle("is-flipped", tr.flipped);
}

$("#tr-stage").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "tr-speak") { e.stopPropagation(); const w = getWords().find((x) => x.id === tr.queue[0]); if (w) speak(w.word); }
  else if (act === "tr-flip") flipCard();
  else if (act === "tr-again") openTrainer(tr.section);
  else if (act === "tr-close") trainer.close();
});
$("#tr-yes").addEventListener("click", () => trainerAnswer(true));
$("#tr-no").addEventListener("click", () => trainerAnswer(false));
$("#tr-dir").addEventListener("click", () => {
  tr.reverse = !tr.reverse;
  tr.flipped = false;
  $("#tr-dir").textContent = tr.reverse ? "RU → IT" : "IT → RU";
  renderTrainer();
});
trainer.addEventListener("keydown", (e) => {
  if (!tr.queue.length) return;
  if (e.code === "Space" || e.code === "Enter") { e.preventDefault(); flipCard(); }
  else if (e.code === "ArrowRight") trainerAnswer(true);
  else if (e.code === "ArrowLeft") trainerAnswer(false);
});
// После закрытия — обновить список: выученные за раунд уйдут из «Учу»
trainer.addEventListener("close", () => render());

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

// Подтянуть всё с GitHub и слить с локальным (ничего не теряя).
async function pullAndMerge() {
  const remote = await Promise.all(COLLECTIONS.map((n) => pullCollection(n)));
  let changed = false;
  COLLECTIONS.forEach((n, i) => { if (remote[i]) changed = mergeRemote(n, remote[i]) || changed; });
  return { changed, remote };
}

// Отправить только изменённые коллекции. Если файл на GitHub успел
// поменяться (другое устройство) — сначала слить, потом отправить.
let pushing = null;
async function pushDirty() {
  if (pushing) return pushing;
  pushing = (async () => {
    let merged = false;
    for (const n of dirtyCollections()) {
      let list = getList(n);
      try {
        await pushCollection(n, list);
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        merged = mergeRemote(n, await pullCollection(n)) || merged;
        list = getList(n);
        await pushCollection(n, list);
      }
      markPushed(n, list);
    }
    if (merged) render();
  })();
  try { await pushing; } finally { pushing = null; }
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

// «Загрузить из GitHub» — версия с GitHub целиком заменяет локальную
$("#btn-pull").addEventListener("click", async () => {
  try {
    toast("Загружаю из GitHub…");
    const remote = await Promise.all(COLLECTIONS.map((n) => pullCollection(n)));
    COLLECTIONS.forEach((n, i) => { if (remote[i]) { setList(n, remote[i], { silent: true }); mergeRemote(n, remote[i]); } });
    const [words, songs, texts, assoc] = remote;
    if (!remote.some(Boolean)) { await checkAccess(); toast("Репозиторий доступен, но файлов данных в нём пока нет", "warn"); }
    else toast(`Загружено: ${words ? words.length : 0} слов, ${songs ? songs.length : 0} песен, ${texts ? texts.length : 0} текстов, ${assoc ? assoc.length : 0} ассоциаций`, "ok");
    render();
    refreshSyncStatus();
  } catch (err) { toast(err.message, "err"); }
});

$("#btn-push").addEventListener("click", async () => {
  try {
    toast("Отправляю в GitHub…");
    await pullAndMerge();
    await pushDirty();
    render();
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

// Автосохранение изменённого (с задержкой), если настроено
let pushTimer = null;
function scheduleAutoPush() {
  if (!isConfigured()) return;
  clearTimeout(pushTimer);
  setSyncStatus("saving");
  pushTimer = setTimeout(async () => {
    try {
      await pushDirty();
      refreshSyncStatus();
      setSyncStatus("saved");
    } catch (err) { console.warn("auto-push failed:", err.message); setSyncStatus("error"); }
  }, 2500);
}

// ── Тулбар / фильтры / вкладки / тема ────────────────────────────────
let searchTimer = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { ui.query = e.target.value; render(); }, 140);
});

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
  window.scrollTo({ top: 0 });
  tab.scrollIntoView({ inline: "nearest", block: "nearest" });
});

$("#btn-edit").addEventListener("click", () => {
  ui.editMode = !ui.editMode;
  $("#btn-edit").classList.toggle("is-on", ui.editMode);
  render();
});

$("#btn-add").addEventListener("click", () => {
  if (ui.section === "song") openSongDialog(null);
  else if (ui.section === "text") openTextDialog(null);
  else if (ui.section === "assoc") openAssocDialog(null);
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
  document.querySelector('meta[name="theme-color"]').setAttribute("content", theme === "dark" ? "#0a0b0f" : "#f7f4ee");
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

// Пробел — играть/пауза (если не печатаем в поле и не в тренировке)
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || !currentSong() || trainer.open) return;
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
  if (wordpop.classList.contains("is-hidden")) return;
  wordpop.classList.add("is-hidden");
  document.querySelectorAll(".w.is-picked").forEach((el) => el.classList.remove("is-picked"));
}

$("#wordpop-speak").addEventListener("click", () => speak(pickedWord));
$("#wordpop-add").addEventListener("click", () => {
  const dup = getWords().find((w) => w.word.toLowerCase() === pickedWord.toLowerCase());
  if (dup) { toast(`«${pickedWord}» уже есть в словаре`, "warn"); closeWordPop(); return; }
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
});

document.addEventListener("click", (e) => {
  if (!wordpop.classList.contains("is-hidden") && !e.target.closest("#wordpop") && !e.target.closest(".w")) closeWordPop();
});
window.addEventListener("scroll", closeWordPop, { passive: true });

// ── Инициализация ────────────────────────────────────────────────────
async function init() {
  applyTheme(localStorage.getItem(KEYS.theme) || "dark");
  await loadInitial();
  subscribe((change) => {
    if (change.quiet) { renderHero(); updateCounts(); }
    else render();
    scheduleAutoPush();
  });
  render();
  renderPlayerbar();
  refreshSyncStatus();

  // Каждый заход — свежие данные с GitHub (слияние, ничего не теряется),
  // потом отправка того, что не успело уйти в прошлый раз.
  if (isConfigured()) {
    try {
      const { changed } = await pullAndMerge();
      if (changed) render();
      if (dirtyCollections().length) scheduleAutoPush();
    } catch (err) { console.warn("sync on start failed:", err.message); }
  }
}
init();
