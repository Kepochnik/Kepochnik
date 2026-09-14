#!/usr/bin/env node
import { runBot } from "../dist/src/bot/telegram.js";
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("set TELEGRAM_BOT_TOKEN (from @BotFather). The bot needs nothing else: no wallet, no key.");
  process.exit(1);
}
await runBot({ token, siteUrl: process.env.BOUNCER_SITE_URL });
