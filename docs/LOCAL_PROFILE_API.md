# Локальный профильный API

Модуль `host/local-api.mjs` предоставляет минимальный HTTP API поверх `createProfileStore`. `host/local-api-host.mjs` собирает файловое хранилище и API в управляемый локальный хост с `start()`/`stop()`.

## Запуск локального API

После задания переменных окружения запустите процесс командой:

```sh
node host/run-local-api.mjs
```

Процесс пишет в консоль адрес и порт, но не выводит токен. Он корректно закрывает сервер при `SIGINT` или `SIGTERM` (например, при Ctrl+C или остановке службы).


Хост создаётся через `createLocalApiHost({ env })`. Обязательные переменные окружения:

- `BUILDBOOK_PROFILE_PATH` — абсолютный путь к файлу канонического профиля.
- `BUILDBOOK_LOCAL_API_TOKEN` — отдельный секрет API длиной не менее 32 байт.

Необязательные:

- `BUILDBOOK_LOCAL_API_HOST` — по умолчанию `127.0.0.1`; разрешены только loopback-адреса.
- `BUILDBOOK_LOCAL_API_PORT` — по умолчанию `43127`; значение `0` выбирает свободный порт (для тестов).

Токен задаётся только в окружении локального процесса и не передаётся браузерному коду. Модуль предоставляет lifecycle API, но пока не является установщиком системной службы и не обеспечивает автозапуск после перезагрузки.

## Маршруты

- `GET /api/health` — проверка доступности процесса.
- `GET /api/profile` — возвращает `{ revision, profile }`; до первого сохранения профиль равен `null`.
- `PUT /api/profile` — принимает `{ expectedRevision, profile }` и возвращает новую ревизию. Устаревшая ревизия даёт HTTP 409 и код `BUILD_BOOK_STORAGE_CONFLICT`.

API принимает JSON до 8 MiB. Ошибки формата возвращаются как 400, неподдерживаемый тип содержимого — 415. Каждый запрос требует `Authorization: Bearer <accessToken>`; токен должен быть не короче 32 байт. Сравнение токена выполняется constant-time. Запросы с посторонним `Origin` или `Host` отклоняются. Сервис разрешено привязывать только к loopback-интерфейсу, не к LAN или публичному адресу.

## Клиентский транспортный модуль

`host/local-profile-client.mjs` — браузерный транспортный клиент для health/read/write. Он принимает API-токен только через аргумент создания клиента, не сохраняет его и не помещает в URL. Перед созданием клиента адрес проверяется: допускаются только HTTP и loopback-хосты `localhost`, `127.0.0.1` или `::1`; внешние хосты, credentials в URL, путь, query и fragment отклоняются до первого запроса. Это предотвращает случайную отправку bearer-токена на произвольный адрес через `baseUrl`, но не защищает от вредоносного ПО с правами того же пользователя. Ошибки сети получают код `BUILD_BOOK_LOCAL_API_UNAVAILABLE`, а конфликт ревизии сохраняет HTTP 409 и код `BUILD_BOOK_STORAGE_CONFLICT`.

Пример использования из доверенного bootstrap-кода:

```js
import { createLocalProfileClient } from './host/local-profile-client.mjs';

const client = createLocalProfileClient({ accessToken: tokenFromSecureBootstrap });
const { profile, revision } = await client.readProfile();
const nextRevision = await client.writeProfile(profile, revision);
```

Этот модуль не является безопасным bootstrap токена и пока не подключён к интерфейсу/IndexedDB. Не передавайте токен из URL, общего профиля, репозитория приложения или Telegram-бота. Запросы из `file://` остаются неподдержанными до решения CORS/origin и безопасной выдачи секрета.

## Адаптер контракта существующего репозитория

`host/profile-repository-adapter.mjs` преобразует формат API-профиля в контракт `repository.readProfile()` / `repository.writeProfile(state, logs, photos, expectedRevision)`. Он сохраняет поля state/logs/photos и кодирует ArrayBuffer/TypedArray фотографии в base64-маркеры для JSON-транспорта, восстанавливая их при чтении. Обычные объекты, совпадающие по форме с бинарным маркером, экранируются как пары ключ-значение; декодирование сохраняет собственные ключи `__proto__` без изменения прототипа. Бинарные дескрипторы проверяются на канонический base64.

Пример сборки слоёв:

```js
import { createLocalProfileClient } from './local-profile-client.mjs';
import { createProfileRepositoryAdapter } from './profile-repository-adapter.mjs';

const client = createLocalProfileClient({ accessToken: tokenFromSecureBootstrap });
const repository = createProfileRepositoryAdapter(client);
```

Адаптер не переключает приложение автоматически и не переносит существующую IndexedDB. При внедрении потребуется отдельный проверяемый процесс импорта и восстановления, а также учёт лимита тела API 8 MiB (base64 увеличивает объём фото примерно на треть). Пока что IndexedDB остаётся активным хранилищем приложения.

## Граница безопасности

Это локальный транспортный слой с обязательным секретом доступа, но пока без безопасной выдачи и ротации токена. Токен API и токен Telegram-бота — разные секреты: токен бота никогда не должен попадать в этот API или клиентский код. Защита от вредоносного процесса под тем же пользователем и безопасный bootstrap токена остаются отдельными задачами.

API пока не подключён к существующему IndexedDB-репозиторию. До реализации миграции и восстановления профиля не использовать его как единственный источник данных.

## Проверки

```sh
node --test tests/local-api.test.mjs tests/local-api-host.test.mjs tests/profile-store.test.mjs
```
