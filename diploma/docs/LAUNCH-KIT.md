# DIPLOMA · launch kit

Everything below is a draft to be filled with numbers the tool prints on launch day. Nothing in a post may be a number the tool did not print.

---

## 1. Идея (RU)

**Что это.** DIPLOMA — read-only инструмент для Robinhood Chain (chain id 4663). Он читает логи Pons V2 и печатает **транскрипт выпуска** токена: за сколько секунд кривая заполнилась, сколько было покупателей, какую долю сбора внёс сам дев, сколько купили в первую минуту, и список покупателей по порядку. Плюс «заглушка держателя»: «ты был покупателем #13 из 40». Плюс ежегодник: сколько запустилось, сколько выпустилось, разбивка по quote-активу (ETH и токенизированные акции).

**Почему именно это.** На Pons запускается ~25 тысяч токенов в день, выпускается около 1 из 100. Половина выпусков происходит за несколько минут: покупка дева → 9 кошельков → sweep. Радары «сколько заполнилась кривая» уже есть (PonsScan, PonsHQ, Augur, GRAID, WORM). Транскрипт выпуска, per-token и per-holder, в родных единицах quote-актива, не печатает никто. Это единственный незанятый кусок «выпускной» ниши, и он же самый честный: не предсказание, а протокол того, что уже произошло.

**Почему это может выстрелить.**
- Артефакт, который постят обе стороны: дев честного выпуска постит «40 покупателей, дев 8%», холдеры бандл-выпуска постят «9 кошельков, дев 62%» как обвинение.
- Заглушка держателя даёт повод постить ранним покупателям каждого настоящего выпуска, а не только девам.
- Печать блока на «печати» делает каждый диплом воспроизводимым: любой запускает тулзу и получает тот же лист.
- 29 сентября заканчивается субсидия газа Robinhood. «Class of Sept 30»: первый день без субсидии, с разбивкой по quote-активам, это карточка, которую будут цитировать.
- Пасхалка: chain id 4663 на кнопочном телефоне набирается как H-O-O-D. Она на каждой печати.

**Чего мы не обещаем.** Лучший builder-репозиторий меты (YOINK, 358★) торгуется около $19k капитализации. Токен здесь «чаевые» инструменту, а не инвестиционный тезис. Так и говорим.

**Что уже готово.** Рабочий CLI (`doctor`, `watch`, `grade`, `print`, `class`, `demo`), 30 офлайн-тестов, ноль runtime-зависимостей (свой keccak, ABI-кодек, JSON-RPC), read-only проверка в CI, маскот-черепаха в академической шапочке, SVG-карточка диплома, GIF-демо.

**Чего не хватает до запуска (нужна машина с доступом к RPC).** Прогнать `diploma doctor`, `diploma class --hours 24`, `diploma print` на 2–3 реальных выпусках, записать реальные цифры в пост, сделать скрин-запись 8–20 секунд.

---

## 2. Маскот

Черепаха в чёрной академической шапочке с золотой кисточкой, держит свёрнутый диплом с красной лентой. Один цвет чернил (navy `#1B2A6B`) на бумаге (`#F3EEDC`), золото `#C9962B` для кисточки и щитков панциря. 1-bit пиксель-арт на сетке 32×32, файлы: `assets/diploma-tortoise.png` (1024), `-transparent.png`, `-128.png`, `.svg`. Рендерится детерминированно из `scripts/draw-mascot.py`.

Почему черепаха: не занята на чейне (капибара, енот, лягушка, канарейка, сова, сурикат, бизон, кот, собака заняты), силуэт «купол + голова» читается на 48px, и это ровно противоположность 4-минутным бандлам: «черепаха тоже выпускается». Цветовой слот «бумага + navy + золото» в мете не занят вообще (все делают лайм на чёрном).

Строчка лора: **«A transcript, not a cheer.»** и **«The tortoise is the meme. The transcript is the product.»**

---

## 3. Главный пост (EN, для X)

Проверенная формула меты: заглавный хук с проблемой → «$0, MIT, runs on your laptop» → имя и одна строка → «[what is happening on screen] 1. 2. 3.» → одна доказательная цифра → границы («no key, no signer») → репо. Тикер в отдельном реплае, после инструмента.

Числа в `[скобках]` заполняются из вывода `diploma class --hours 24` и `diploma print` в день поста.

```
HALF OF ALL PONS GRADUATIONS ON ROBINHOOD CHAIN HAPPEN IN UNDER FOUR MINUTES. YOUR "GRADUATED" COIN WAS ONE DEV BUY, NINE WALLETS AND A SWEEP.

$0, MIT license, runs on your laptop.

DIPLOMA takes a graduated Pons V2 token and prints the transcript: seconds from launch to sweep, how many wallets bought, what share the dev funded, what share landed in the first minute.

[what is happening on screen]
1. watch reads the factory: launched, swept, graduated
2. print reads the curve's own buy/sell logs between launch and sweep
3. the diploma comes out with the block on the seal, so you can re-run it and get the same paper

yesterday's class: [N] launched, [M] graduated, median [S] s from launch to sweep. [K]% of graduates were more than half funded by their own dev.

no key. no signer. no transaction path. a diploma is a transcript of the past, not a buy signal.

github.com/Kepochnik/diploma
```

Реплай 1 (в тот же тред, сразу):

```
two graduations, same 4.2 ETH raised, same chart shape.

$[A]: 212 s · 9 buyers · dev funded 62% · 71% bought in the first minute
$[B]: 62 min · 40 buyers · dev funded 8%

one of them has a class. run `diploma print` on your bag before you call it a graduation.
```

Реплай 2 (через 1–3 часа, после того как репо набрало звёзды):

```
if you bought a real graduation early, `diploma print <token> --holder <you>` prints your stub: "buyer #13 of 40", block number included. that is your receipt. post it.
```

Реплай 3 (когда токен запущен, и только тогда):

```
$DIPLOMA is live on Pons: 0x[CA]
ponsfamily.com/launchpad/0x[CA]

the tool is the product. the token is the tip jar. the tortoise is the meme.
chain id 4663. type it on a nokia.
```

**Вложение:** GIF `assets/readme/demo.gif` (или экранная запись `diploma watch` на реальном чейне, 8–20 секунд) и карточка `assets/readme/diploma-card-demo.png`.

**Второй волной (30 сентября утром):** карточка `diploma class --hours 24` с заголовком «Class of Sept 30: first day without the gas subsidy», разбивка по ETH и стоковым парам.

---

## 4. Главный пост (RU, перевод для вас)

```
ПОЛОВИНА ВСЕХ ВЫПУСКОВ НА PONS ПРОИСХОДИТ БЫСТРЕЕ ЧЕТЫРЁХ МИНУТ. ВАШ «ВЫПУСТИВШИЙСЯ» КОИН ЭТО ОДНА ПОКУПКА ДЕВА, ДЕВЯТЬ КОШЕЛЬКОВ И SWEEP.

$0, лицензия MIT, работает на вашем ноутбуке.

DIPLOMA берёт выпустившийся токен Pons V2 и печатает транскрипт: секунды от запуска до sweep, сколько кошельков купило, какую долю профинансировал дев, сколько купили в первую минуту.

[что происходит на экране]
1. watch читает фабрику: запущен, свипнут, выпущен
2. print читает логи покупок/продаж самой кривой между запуском и sweep
3. диплом выходит с номером блока на печати: перезапустите и получите тот же лист

вчерашний класс: [N] запущено, [M] выпущено, медиана [S] с от запуска до sweep. [K]% выпускников больше чем наполовину профинансированы своим же девом.

без ключа. без подписи. без транзакций. диплом это транскрипт прошлого, а не сигнал к покупке.

github.com/Kepochnik/diploma
```

---

## 5. Чек-лист запуска

1. **Репозиторий.** Создать `github.com/Kepochnik/diploma`, залить содержимое папки `diploma/`, включить Actions (CI прогонит read-only проверку и тесты на Node 22/24). В описании репо после запуска токена: `Official CA: 0x…`.
2. **Реальные цифры.** На машине с доступом к RPC: `npm run doctor`; `node bin/diploma.mjs class --hours 24 --format markdown`; `node bin/diploma.mjs print <2–3 свежих выпуска>`. Заполнить `[N] [M] [S] [K] [A] [B]` в посте. Ни одной цифры, которую тулза не напечатала.
3. **Запись экрана.** `node bin/diploma.mjs watch --interval 5` 8–20 секунд, затем `print` одного выпуска. Или взять `assets/readme/demo.gif`, но тогда в посте явно написать «demo chain».
4. **Аккаунты.** Отдельный X-аккаунт токена (`@diploma_rh` или похожий), в био: «a transcript, not a cheer», ссылка на репо. Основной пост с личного аккаунта, токен-аккаунт только ретвитит и отвечает.
5. **Сначала инструмент, потом токен.** Пост с репо утром; звёзды и форки 1–3 часа; токен на Pons V2 днём того же дня или на следующий. В мете это норма (BODKIN: «One day ago Bodkin was a terminal… then a coin»).
6. **Параметры запуска на Pons V2** (ponsfamily.com, launch V2): имя `Diploma`, тикер `DIPLOMA`, quote-актив ETH (стандартный конфиг, порог 4.2 ETH); creator tax 1–2% (10% максимум по контракту, высокий читается как «дев доит»); buyback vault включён, но в посте честно: он вестится обратно создателю и протоколу 5 лет, а не сжигает; dev buy минимальный или ноль. Ноль подписей до этого шага; сам запуск это транзакция, её делаете вы из кошелька.
7. **Первые 10 минут после CA.** Обновить строку `Official CA` в README и описании репо, реплай 3 в тред, `diploma print` на собственный токен, когда он выпустится (если выпустится), и опубликовать свой же транскрипт первым.
8. **Прирост.** Каждому, кто пишет «выпустился», отвечать транскриптом. Каждому раннему холдеру реального выпуска предлагать `--holder` заглушку.
9. **30 сентября.** Утром карточка «Class of Sept 30» без субсидии газа.
10. **Проверить до поста** с незаблокированной машины: нет ли токена `DIPLOMA` на dexscreener/robinhood, GMGN и ponsfamily; Bitquery-цифра «половина за 4 минуты» подтверждается вашим `class` или заменяется вашей медианой.

---

## 6. Риски, названные заранее

- Ниша «выпуск» занята радарами; наш ответ: транскрипт постфактум, per-holder, quote в родных единицах, и мы называем конкурентов в README сами.
- Токен может остаться «чаевыми» (см. YOINK). Мы это говорим в посте, а не скрываем.
- Публичный RPC может резать логи на очень активных кривых; `--chunk` и `--rpc` в README.
- Транскрипт называет адреса, не людей, и не заявляет о намерениях. Слова в выводе нейтральные: «dev funded 62%», а не «rug».
- Если девы бандл-выпусков начнут дробить покупку дева на свежие кошельки, «dev funded» упадёт, а «first minute» и «buyers with one buy each» останутся. Это v0.2: кластер кошельков, профинансированных из одного источника.
