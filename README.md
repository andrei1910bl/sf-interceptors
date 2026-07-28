# Общая схема (как всё связано)

```
Клиент (Postman / другая программа)
        |
        |  POST /payments
        v
   index.js  (наш сервер)
        |
        |  отправляет запрос
        v
   sfClient.js  (axios + interceptors)
        |
        |  REST API
        v
   Salesforce
        |
        |  если ошибка
        v
   sfErrors.js  (разбор status code и ошибок)
```

И так: **index.js** принимает запросы, **sfClient.js** ходит в Salesforce, **sfErrors.js** помогает понять что пошло не так.

---

## 1. `index.js` — главный файл

Это точка входа. Когда мы пишем `npm start` или `docker run`, запускается именно он.

### Что он делает

1. Поднимает **Express** сервер (это библиотека для HTTP)
2. Слушает порт (по умолчанию **3000**, можно поменять через `.env`)
3. Принимает JSON в теле запроса

Старт сервера выглядит примерно так:

```js
import express from 'express';
import sfClient, { getInstanceUrl } from './sfClient.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json()); // чтобы понимать JSON в теле запроса

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
```

### Эндпоинты

#### `GET /health`

Просто проверка что сервер жив. Удобно для Docker и тестов.

Ответ примерно такой:

```json
{
  "success": true,
  "service": "sf-interceptors",
  "salesforceInstance": "https://....salesforce.com"
}
```

#### `POST /payments`

Самый важный endpoint. Сюда мы кидаем данные про payment / opportunity.

Можно отправить **два варианта** тела:

**Вариант 1 — одна запись:**

```json
{
  "Opportunity": "INV-00002",
  "Amount": 1500,
  "FirstName": "Andrei",
  "LastName": "Bul"
}
```

**Вариант 2 — массив:**

```json
{
  "payments": [
    {
      "Opportunity": "INV-00002",
      "Amount": 1500,
      "FirstName": "Andrei",
      "LastName": "Bul"
    }
  ]
}
```

### Внутренние функции

- `buildPaymentsPayload(body)` — приводит входящий JSON к нужному формату `{ payments: [...] }`
- `validatePaymentsPayload(payload)` — проверяет что есть `Opportunity` (обязательное поле)

`buildPaymentsPayload` — если пришёл массив, оставляем как есть. Если пришли отдельные поля, оборачиваем в массив:

```js
function buildPaymentsPayload(body) {
    if (Array.isArray(body.payments)) {
        return { payments: body.payments };
    }

    return {
        payments: [{
            Opportunity: body.Opportunity,
            Amount: body.Amount,
            FirstName: body.FirstName,
            LastName: body.LastName
        }]
    };
}
```

`validatePaymentsPayload` — проверяем что массив не пустой и у каждого payment есть `Opportunity`:

```js
function validatePaymentsPayload(payload) {
    if (!Array.isArray(payload.payments) || payload.payments.length === 0) {
        return 'Request body must contain a non-empty "payments" array or payment fields';
    }

    for (const [index, payment] of payload.payments.entries()) {
        if (!payment.Opportunity) {
            return `Payment at index ${index} is missing required field "Opportunity"`;
        }
    }

    return null; // null = всё ок
}
```

Если валидация не прошла — сразу отдаём **400** и не идём в Salesforce.

### Что происходит при успехе

Если Salesforce ответил нормально, мы возвращаем клиенту:

```json
{
  "success": true,
  "source": "salesforce",
  "status": 200,
  "data": { ... }
}
```

### Главный обработчик `POST /payments`

Вот как выглядит вся логика endpoint'а — тут видно и валидацию, и вызов Salesforce, и обработку ошибок:

```js
app.post('/payments', async (req, res) => {
    const payload = buildPaymentsPayload(req.body);
    const validationError = validatePaymentsPayload(payload);

    if (validationError) {
        return res.status(400).json({
            success: false,
            source: 'integration',
            status: 400,
            error: 'VALIDATION_ERROR',
            message: validationError
        });
    }

    try {
        const response = await sfClient.post('/services/apexrest/payments/', payload);

        return res.status(response.status).json({
            success: true,
            source: 'salesforce',
            status: response.status,
            data: response.data
        });
    } catch (error) {
        const formatted = error.salesforce || buildSalesforceError(error);
        return res.status(formatted.status).json(formatted.body);
    }
});
```

### Что происходит при ошибке

Ловим ошибку в `catch`, берём уже готовый объект из `error.salesforce` (его формирует interceptor) и отдаём клиенту **тот же HTTP status**, что вернул Salesforce.

---

## 2. `sfClient.js` — клиент для Salesforce + interceptors

Мы используем **axios** — это как fetch, только удобнее.

### Переменные

```js
let accessToken = ...
let instanceUrl = ...
```

- `accessToken` — токен доступа к Salesforce
- `instanceUrl` — URL нашего org (типа `https://xxx.my.salesforce.com`)

Они могут прийти из `.env` (`SF_ACCESS_TOKEN`, `SF_INSTANCE_URL`) или получиться после логина.

### Функция `loginToSalesforce()`

Если токена нет — логинимся через OAuth:

- endpoint: `{SF_LOGIN_URL}/services/oauth2/token`
- grant_type: `password`
- берём client_id, client_secret, username, password из `.env`

После успеха сохраняем `access_token` и `instance_url`.

```js
async function loginToSalesforce() {
    const response = await axios.post(
        `${process.env.SF_LOGIN_URL}/services/oauth2/token`,
        null,
        {
            params: {
                grant_type: 'password',
                client_id: process.env.SF_CLIENT_ID,
                client_secret: process.env.SF_CLIENT_SECRET,
                username: process.env.SF_USERNAME,
                password: process.env.SF_PASSWORD
            }
        }
    );

    accessToken = response.data.access_token;
    instanceUrl = response.data.instance_url;
}
```

### Interceptor запроса (request interceptor)

Срабатывает **перед каждым** запросом в Salesforce:

1. Проверяет есть ли токен
2. Если нет — вызывает `loginToSalesforce()`
3. Ставит:
   - `baseURL = instanceUrl`
   - `Authorization: Bearer <token>`
   - `Content-Type: application/json`

То есть нам не нужно каждый раз руками прописывать заголовки

```js
sfClient.interceptors.request.use(async (config) => {
    if (!accessToken) {
        await loginToSalesforce();
    }

    config.baseURL = instanceUrl;
    config.headers['Authorization'] = `Bearer ${accessToken}`;
    config.headers['Content-Type'] = 'application/json';

    return config;
});
```

### Interceptor ответа (response interceptor)

Срабатывает когда Salesforce вернул ошибку:

1. Парсит ошибку через `parseSalesforceErrors()`
2. Логирует через `logSalesforceError()`
3. Обрабатывает status code через `handleHttpStatus()`
4. Кладёт красивый объект в `error.salesforce`

#### Авто-перелогин (retry)

Если пришло:

- HTTP **401**, или
- errorCode **INVALID_SESSION_ID**

...то мы:

1. Сбрасываем токен
2. Логинимся заново
3. **Повторяем тот же запрос один раз** (`_retry = true`)

Это удобно, потому что токены иногда протухают.

```js
const sessionExpired = status === 401
    || errors.some((item) => item.errorCode === 'INVALID_SESSION_ID');

if (sessionExpired && originalRequest && !originalRequest._retry) {
    originalRequest._retry = true;
    accessToken = null;
    await loginToSalesforce();
    originalRequest.headers['Authorization'] = `Bearer ${accessToken}`;
    return sfClient(originalRequest); // повторяем запрос 1 раз
}
```

### Экспорт

- `export default sfClient` — сам axios клиент
- `export function getInstanceUrl()` — чтобы `index.js` мог показать URL в `/health`

---

## 3. `sfErrors.js` — обработка ошибок и status codes

Этот файл я бы назвал "переводчиком ошибок Salesforce".

Salesforce может вернуть ошибку по-разному:

- массив `[{ errorCode, message, fields }]`
- OAuth формат `{ error, error_description }`
- один объект `{ message, errorCode }`
- просто строку

### `parseSalesforceErrors(data)`

Приводит всё к одному формату. Salesforce может прислать массив, OAuth-ошибку или просто строку — мы это всё разбираем:

```js
export function parseSalesforceErrors(data) {
    // вариант 1: массив ошибок REST API
    if (Array.isArray(data)) {
        return data.map((item) => ({
            errorCode: item.errorCode,
            message: item.message,
            fields: item.fields || []
        }));
    }

    // вариант 2: OAuth ошибка
    if (data?.error || data?.error_description) {
        return [{
            errorCode: data.error || 'OAUTH_ERROR',
            message: data.error_description || 'OAuth error'
        }];
    }

    return [];
}
```

### `buildSalesforceError(error)`

Главная функция для ответа клиенту.

- Если **нет response** (сеть упала) → status **502**, error `NETWORK_ERROR`
- Если response есть → берём **status от Salesforce** и формируем JSON

```js
export function buildSalesforceError(error) {
    if (!error.response) {
        return {
            status: 502,
            body: {
                success: false,
                source: 'integration',
                error: 'NETWORK_ERROR',
                message: error.message || 'Failed to reach Salesforce'
            }
        };
    }

    const { status, data } = error.response;
    const errors = parseSalesforceErrors(data);
    const primary = errors[0];

    return {
        status,
        body: {
            success: false,
            source: 'salesforce',
            status,
            error: primary?.errorCode || `HTTP_${status}`,
            message: primary?.message || STATUS_MESSAGES[status],
            errors: errors.length > 0 ? errors : undefined
        }
    };
}
```

Пример того, что получит клиент:

```json
{
  "success": false,
  "source": "salesforce",
  "status": 400,
  "error": "REQUIRED_FIELD_MISSING",
  "message": "...",
  "errors": [ ... ]
}
```

### `STATUS_MESSAGES`

Таблица с текстами для стандартных HTTP кодов:

```js
const STATUS_MESSAGES = {
    400: 'Bad Request — invalid or missing data',
    401: 'Unauthorized — invalid or expired session',
    403: 'Forbidden — insufficient permissions',
    404: 'Not Found — record or endpoint does not exist',
    // ...
};
```

| Code | Что значит (коротко) |
|------|----------------------|
| 400 | плохой запрос / не хватает полей |
| 401 | не авторизован / токен протух |
| 403 | нет прав |
| 404 | не найдено |
| 409 | конфликт / дубликат |
| 429 | слишком много запросов |
| 500 | ошибка сервера SF |
| 503 | SF временно недоступен |

### `logSalesforceError(status, errors)`

Пишет ошибки в консоль, чтобы в Docker logs было видно что случилось.

### `handleHttpStatus(status, errors)`

Дополнительно логирует "человеческие" предупреждения по status code и по `errorCode` (например `DUPLICATE_DETECTED`, `NOT_FOUND` и т.д.):

```js
switch (item.errorCode) {
    case 'REQUIRED_FIELD_MISSING':
        console.warn('Required field missing in payload.');
        break;
    case 'DUPLICATE_DETECTED':
        console.warn('Duplicate rules blocked this request.');
        break;
    case 'INVALID_SESSION_ID':
        console.warn('Session is invalid or expired.');
        break;
    // ...
}
```

---

## Пример полного flow

1. Я отправляю POST на `http://localhost:3000/payments`
2. `index.js` проверяет JSON
3. `index.js` вызывает `sfClient.post('/services/apexrest/payments/', payload)`
4. `sfClient` через interceptor добавляет token и baseURL
5. Salesforce отвечает (200 или ошибка)
6. Если ошибка → interceptor + `sfErrors.js` формируют `error.salesforce`
7. `index.js` возвращает клиенту status + JSON

---

## Переменные окружения которые используются

| Переменная | Где нужна | Зачем |
|---|---|---|
| `PORT` | index.js | порт сервера |
| `SF_LOGIN_URL` | sfClient.js | URL для OAuth |
| `SF_CLIENT_ID` | sfClient.js | client id |
| `SF_CLIENT_SECRET` | sfClient.js | client secret |
| `SF_USERNAME` | sfClient.js | логин |
| `SF_PASSWORD` | sfClient.js | пароль + security token |
| `SF_ACCESS_TOKEN` | sfClient.js | готовый токен (если есть) |
| `SF_INSTANCE_URL` | sfClient.js | URL org |

---

## Как запустить и проверить

```bash
npm install
npm start
```

Проверка health:

```bash
curl http://localhost:3000/health
```

Отправка payment:

```bash
curl -X POST http://localhost:3000/payments \
  -H "Content-Type: application/json" \
  -d '{"Opportunity":"INV-00002","Amount":1500,"FirstName":"Andrei","LastName":"Bul"}'
```

