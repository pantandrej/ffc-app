# Football Fight Club — Прогнозиста ЧМ-2026

Турнир прогнозов к Чемпионату мира 2026. Стек: React + Vite + Supabase.

## Быстрый старт

```bash
# 1. Установить зависимости
npm install

# 2. Запустить локально
npm run dev
# → http://localhost:5173

# 3. Собрать продакшн-билд
npm run build
# → папка dist/

# 4. Превью билда локально
npm run preview
```

## Деплой на Vercel

### Через Vercel CLI
```bash
npm i -g vercel
vercel
```

### Через GitHub
1. Запушь проект в GitHub-репозиторий.
2. Открой [vercel.com](https://vercel.com) → **New Project** → выбери репозиторий.
3. Vercel автоматически определит Vite.  
   Настройки по умолчанию правильные:
   - **Framework:** Vite
   - **Build command:** `npm run build`
   - **Output directory:** `dist`
4. Нажми **Deploy**.

## Структура проекта

```
ffc-app/
├── index.html          # точка входа
├── vite.config.js      # конфиг Vite
├── vercel.json         # SPA rewrites
├── package.json
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx        # рендер React root
    └── App.jsx         # всё приложение (v6)
```

## Supabase

Переменные хранятся прямо в `src/App.jsx` (константы `SUPABASE_URL` и `SUPABASE_KEY`).  
Для production рекомендуется вынести в `.env`:

```env
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_KEY=eyJ...
```

И в коде заменить на:
```js
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY;
```

## Меню приложения

| Вкладка | Кто видит |
|---|---|
| Отправить прогноз | все |
| Таблица лидеров | все |
| ⚙ Админ | только admin |

Плей-офф, бонусы и рейтинг третьих мест — **секции внутри «Отправить прогноз»**, не отдельные вкладки.
