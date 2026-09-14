# BOUNCER · launch kit

Numbers in `[brackets]` come from the tool on launch day. Nothing in a post may be a number the tool did not print.

## 1. Идея (RU)

BOUNCER — вышибала у двери каждого запуска на Pons V2. Вставляете адрес токена (или кривой) и получаете «слип»: **ID check** (фабрика Pons реально задеплоила этот токен? код может измениться?), **cover charge** (открыт ли ещё 99% анти-снайп налог первых 15 секунд, и сколько реально заплатили те, кто зашёл в окно), **house rules** (комиссии, куда идёт налог создателя, что «buyback» не сжигает, а вестится обратно создателю 5 лет) и **dev report card** (что этот деплоер запускал раньше и чем это кончилось). Штамп `ON THE LIST` / `NOT ON THE LIST` и заметки: STOP / WATCH / INFO.

Почему этим будут пользоваться: это не радар и не скор. Это то, что человек проверяет за 10 секунд перед покупкой, и то, что постят в ответ на «graduating tonight». Сайт работает в браузере без кошелька, CLI без ключей, всё воспроизводимо по номеру блока на штампе.

## 2. Маскот

Горилла-вышибала: чёрная футболка с красным значком, «обмотанные» тёмные очки, наушник-гарнитура из латуни, руки скрещены. 32×32 пиксель-арт, рендерится детерминированно из `scripts/draw-mascot.py`. Палитра: дверь `#0e0d10`, латунь `#c9a227`, бархатный канат `#b3122e`. Строчка лора: **«Check the list before you pay the cover.»** и **«The gorilla is the meme. The slip is the product.»**

## 3. Главный пост (EN)

```
EVERY PONS LAUNCH HAS A 99% DOOR TAX FOR FIFTEEN SECONDS. THE DEV IS EXEMPT. YOU ARE NOT.

$0, MIT license, runs in your browser or your terminal.

BOUNCER checks the list before you pay the cover: did the Pons factory actually deploy this token, is the door tax still open, what did the wallets inside the window really pay, what are the house rules, what did this dev launch before.

[what is happening on screen]
1. paste the address; the factory says whether it made this token
2. the cover charge counts down from the launch block, with every buy inside the window and what it paid
3. house rules in plain words, the dev's report card, a stamp: ON THE LIST or NOT ON THE LIST

[N] launches checked today. [K] of them charged 10% on every trade. [M] were not on the list at all.

no key. no signer. no transaction path. the slip says what is true at one block, not what happens next.

github.com/Kepochnik/bouncer
```

Реплай 1:

```
same name, same logo, two addresses.

0x…[A]: ON THE LIST · cover charge closed · 3% per trade · dev: 1 launch, 1 graduated
0x…[B]: NOT ON THE LIST · upgradeable proxy · SELFDESTRUCT

one of them is the token. paste both.
```

Реплай 2 (когда есть свежий пример):

```
launched [S] s ago. cover charge still open: [T] s left, up to 99% on a buy right now.
wallet 0x…[W] didn't wait and paid [P]% at the door.

bouncer door 0x…[CA]
```

Реплай 3 (только после запуска токена):

```
$BOUNCER is live on Pons: 0x[CA]
the tool is the product. the token is the tip jar. the gorilla is the meme.
```

## 4. Чек-лист

1. Репо `github.com/Kepochnik/bouncer` из папки `bouncer/`, Actions включены (CI + Pages). В настройках Pages выбрать «GitHub Actions».
2. На машине с RPC: `npm run doctor`, затем `bouncer door` на 3–5 свежих запусках (ищите открытый cover charge) и на 1–2 самозванцах. Заполнить `[N] [K] [M] [A] [B] [S] [T] [W] [P]`.
3. Проверить в браузере live-режим с публичным RPC; если CORS не пускает — указать в README рабочий эндпоинт или прокси.
4. Скринкаст 8–20 с: вставка адреса → обратный отсчёт cover charge → штамп.
5. Сначала инструмент, потом токен (через 1–3 часа или на следующий день). Параметры на Pons V2: creator tax 1–2%, buyback on, dev buy минимальный; в посте честно про вестинг.
6. Первые 10 минут после CA: строка `Official CA` в README и описании репо, реплай 3, `bouncer door` на собственный токен и его слип первым.
