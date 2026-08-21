// Настройки приложения.
// Синхронизация читает/пишет данные в ПРИВАТНОМ репозитории italian-words-data.
export const GITHUB = {
  owner: "Freaking-Bread",       // имя пользователя GitHub
  repo: "italian-words-data",    // приватный репозиторий с реальными данными
  branch: "main",
  paths: {
    words: "words.json",         // слова / связки / правила
    songs: "songs.json",         // песни (текст + перевод)
    texts: "texts.json",         // тексты для заучивания (про меня)
    assoc: "assoc.json",         // картинки-ассоциации к словам
  },
  dirs: {
    audio: "audio",              // mp3-файлы песен
    images: "images",            // картинки к правилам
  },
};

// Ключи в localStorage (префикс it_ — italian)
export const KEYS = {
  words:    "it_words_v1",
  songs:    "it_songs_v1",
  texts:    "it_texts_v1",
  assoc:    "it_assoc_v1",
  token:    "it_gh_token",
  shaWords: "it_gh_sha_words",
  shaSongs: "it_gh_sha_songs",
  shaTexts: "it_gh_sha_texts",
  shaAssoc: "it_gh_sha_assoc",
  theme:    "it_theme",
  dataVer:  "it_data_version",
  lastSync: "it_last_sync",
};

// Версия данных. Если в браузере лежит кэш от прошлой версии, приложение
// один раз само подтянет свежие данные из GitHub (иначе показывало бы старый
// список из localStorage, пока не нажмёшь «Загрузить из GitHub» вручную).
export const DATA_VERSION = 2;

// Стартовые данные при первом заходе (демо в публичном репозитории)
export const DATA_URL = {
  words: "data/words.json",
  songs: "data/songs.json",
  texts: "data/texts.json",
  assoc: "data/assoc.json",
};
