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
  token:    "it_gh_token",
  shaWords: "it_gh_sha_words",
  shaSongs: "it_gh_sha_songs",
  shaTexts: "it_gh_sha_texts",
  theme:    "it_theme",
  lastSync: "it_last_sync",
};

// Стартовые данные при первом заходе (демо в публичном репозитории)
export const DATA_URL = {
  words: "data/words.json",
  songs: "data/songs.json",
  texts: "data/texts.json",
};
