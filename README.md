**english** · [русский](README.ru.md)

# decision capsule

save a decision with its context, then come back on a chosen day to record what happened.

[open the app](https://chebaturkin.github.io/decision-capsule/?lang=en)

a capsule keeps your question, options, chosen path, confidence and review date. when that date arrives, open it manually and add a result. the original decision stays unchanged.

## a look inside

the archive has search, filters and sorting. these screenshots use demonstration entries.

![decision archive with sealed, ready and opened capsules](docs/screenshots/en/archive.png)

<details>
<summary>create a capsule</summary>

![writing a question in a new capsule](docs/screenshots/en/create.png)

</details>

<details>
<summary>the decision and its result</summary>

![an opened capsule with its original context and recorded result](docs/screenshots/en/detail.png)

</details>

<details>
<summary>on a phone</summary>

<img src="docs/screenshots/en/mobile-create.png" alt="creating a capsule on a phone" width="320">

</details>

## where the data stays

capsules are saved in indexeddb in this browser. there is no account, server database or analytics. download the archive to keep a backup or move your entries to another browser.

review dates follow your device calendar and time zone. the app does not send reminders. you need to return and open a capsule yourself.

## move your entries

- **download archive** saves every capsule in a json file.
- **import archive** checks the file, counts new and duplicate capsules, then adds new entries after confirmation.
- **download note** saves one capsule as markdown, with labels in the current interface language.
- **capsule link** carries one entry in a link.

link data is not encrypted. anyone with the link can read the capsule.

## language

use **ru / en** in the header. a valid `?lang=ru` or `?lang=en` link takes priority, followed by your saved choice, the first supported browser language and english as the fallback. switching keeps your current step, unsaved text, archive and other url parameters. your own writing is never translated.

## run locally

```sh
npm install
npm run dev
```

open `http://127.0.0.1:5173`. the app uses html, css and javascript without a framework. its fonts and logo make no external requests.

## checks and build

```sh
npm test
npm run build
```

the build writes static files to `dist` for github pages. it does not read user data.

with a local server running, python, playwright and chromium installed:

```sh
python3 tests/ui_smoke.py
I18N_URL=http://127.0.0.1:5173 python3 tests/i18n_browser.py
```

the checks use an isolated temporary browser. they cover creation, draft recovery, opening, results, search, filters, sorting, import, export, dialog focus, language switching and mobile widths. they do not use your saved data.

to refresh the russian demonstration screenshots:

```sh
python3 tests/ui_smoke.py --screenshots
```
