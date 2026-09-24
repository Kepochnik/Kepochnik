# SHOULDA: план запуска

## Идея в одном предложении

Вставляешь кошелёк, и SHOULDA прогоняет каждый твой мемкоин-ape на Robinhood Chain так,
будто вместо него ты купил SPY по цене Chainlink в ту же минуту. Итог: карточка «ты vs
S&P 500», которую хочется запостить.

## Почему это может выстрелить

1. **Нарратив чейна в одной картинке.** Главный спор про Robinhood Chain: «сделали чейн
   для акций, а его захватили мемкоины». SHOULDA буквально ставит их рядом на одном графике.
2. **Только здесь.** Акции лежат ончейн как ERC-20 с фидами Chainlink в том же чейне, что
   и Pons. На Solana или Base такую точную математику не построишь.
3. **Встроенный виральный цикл.** Каждый результат — картинка для X. Проиграл: самоирония
   («gramps is not mad, just disappointed»). Выиграл: хвастовство («я обогнал S&P»).
   Постят оба варианта.
4. **Продукт работает за 10 секунд.** Не надо подключать кошелёк и ничего не надо
   настраивать: вставил адрес и получил ответ.

## Проверка на дубли (24.09.2026)

Среди соседних builder-проектов:

| Проект | Что делает |
| --- | --- |
| COPY | копитрейд |
| Canary | следит за девами Pons |
| RUMZO | сверяет код с контрактом |
| HOPOUT | считает ликвидность на выход |
| PELLET | ловит спящих китов |
| FOMO Radar | сигналы от хороших трейдеров |
| assay / jev-bot | AI-прогнозы |
| YOINK | заметки и прогнозы |
| rh-chain-wallet-lens | PnL по кошельку |

Сравнения «мемы vs акции» по кошельку нет ни у кого. Поиск по GitHub и вебу тоже ничего
не нашёл. Самый близкий — wallet-lens, но он считает обычный PnL без бенчмарка.

## Маскот: Gramps 🐢

Пиксельная черепаха в кепке и очках для чтения, с полуприкрытыми веками. Выражение
лица — «я не злюсь, я разочарован».

- **Почему черепаха.** Черепаха и заяц: медленный индекс против быстрых мемов. Считывается
  без объяснений.
- **Почему дед.** «Boomer stocks» — давний мем крипто-твиттера. Здесь бумер наконец прав.
- **Характер.** Спокойный, сухой юмор, никогда не орёт. «Gramps bought SPY in 1993 and
  went fishing.»
- **Отличие.** У соседей уже есть капибара, канарейка, енот, лягушка, кот и сова.
  Черепахи нет.

Файлы: `mascot/gramps.svg`, `mascot/gramps.png` (сетка 30×22 в `src/render/gramps.mjs`).

Промпт для художника или генератора, чтобы сделать хай-рез версию:

> 32-bit pixel art mascot, an old grumpy-but-kind turtle facing right, dark green shell with
> one tiny neon lime (#C6F432) highlight, light green skin, brown flat cap, small round
> reading glasses, half-closed unimpressed eyelids, flat slightly downturned mouth,
> thick near-black outline, transparent background, crisp pixels, no text

## Токен $SHOULDA

**Запуск:** Pons V2, пара с ETH.

Пара с NVDA/SPY звучит смешнее, но покупателю сначала нужен сам Stock Token. Это лишний
шаг, и часть людей до него не дойдёт. ETH-пара даёт максимальный охват.

**Как токен вшит в продукт (просто, без обещаний дохода):**

1. **Gramps' Fund.** Комиссии создателя с Pons (в ETH) раз в неделю публично переводятся в
   SPY Stock Token на отдельный кошелёк. Раз в неделю выходит пост с чеком: «Gramps bought
   0.8 SPY this week». Казна делает ровно то, что советует маскот. Это постоянный повод
   для контента, и всё видно ончейн.
2. **Токен роастит сам себя.** На сайте живая строка: «$SHOULDA vs SPY с момента запуска».
   Если токен проигрывает индексу, Gramps пишет это на главной. Честность — часть мема.
3. **Hall of Shame / Hall of Fame (v2).** Недельный лидерборд кошельков, которые сами
   решили в нём участвовать. Держатели $SHOULDA получают на карточке рамку «Gramps
   approved».

**Риски, которые надо закрыть до запуска:**

- **Stock Tokens.** Проверить, может ли кошелёк фонда вообще держать и покупать SPY Stock
  Token: в документации Robinhood сказано про eligibility, а контракты апгрейдятся через
  beacon. Если не может, фонд держит ETH и публикует чеки так же.
- **Юридика.** Нигде не обещать держателям долю в фонде или доход. Фонд — это казна
  проекта и шоу, а не дивиденды. Иначе конструкция начинает выглядеть как ценная бумага.
- **Приватность.** Карточку по чужому кошельку можно сделать без спроса. Для запуска
  роастить только себя и тех, кто сам прислал адрес. KOL-кошельки брать только с согласия.

## Главный пост (X)

Картинка к посту: карточка с кошелька дева, то есть самоирония. Никогда не берите чужой
кошелёк без спроса.

```
robinhood chain is the only chain where your memecoins and the S&P 500 trade side by side

so we built the receipt nobody asked for

paste a wallet → every ape you ever made gets replayed into SPY at the chainlink price that day

this is mine. gramps is not mad. just disappointed

$SHOULDA 🐢
```

Первый реплай:

```
open source. read-only. no wallet connect.

npx shoulda-cli <your wallet>

github.com/<org>/shoulda
CA: <после деплоя на pons>
```

Второй реплай (виральная механика):

```
drop your wallet below

gramps will replay it and post your card

yes, even you, 40x-on-one-coin-then-round-tripped-it guy
```

### Альтернативные хуки для A/B

- `every memecoin you ever bought, replayed into NVDA. i wish i hadn't checked`
- `built a tool that tells you how much the S&P 500 would have made you instead of your memecoins. ran it on myself first. mistake`
- `robinhood built a chain for stocks. degens used it for memecoins. we built the scoreboard`

## Порядок запуска

1. **День −2.** Выложить репо с работающим `npx shoulda-cli demo` и карточкой в README.
2. **День −1.** Прогнать 5–10 кошельков друзей и KOL-ов (только с согласия), сохранить
   карточки.
3. **День 0.** Задеплоить $SHOULDA на Pons, выложить главный пост с карточкой дева, в
   реплаях — GitHub и CA. Весь день роастить кошельки из комментариев.
4. **Неделя 1.** Первый чек Gramps' Fund. Веб-версия: вставил адрес, получил PNG,
   поделился в один клик.

## Что строить дальше (по приоритету)

1. **Веб-страница с PNG-карточкой и кнопкой «Share on X».** Это главный виральный канал:
   CLI — для доверия, веб — для масс.
2. **Telegram-бот.** Скинул адрес — получил карточку.
3. **Режим `--since`.** «С начала месяца» или «с запуска Pons V2».
4. **Бенчмарк `--vs PONS`.** Твои мемы против самого лаунчпада.
