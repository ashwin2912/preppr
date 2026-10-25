# For the kitchen owner

Five minutes of setup on your phone, then the bot takes the morning orders.

## 1. Tell the bot who your regulars are

Regulars skip the sign-up questions and can order with one message.

- **Easiest:** open the chat with the bot → 📎 (attach) → **Contact** → tick your customers → **Send**. The bot replies "Added 12 customers…". You can do this again any time; it never removes anything.
- **Lots of contacts at once:** export them from your phone (iPhone: Contacts → Lists → select → Export; Android: contacts.google.com → Export → vCard) and send the `.vcf` file to whoever runs the bot.
- **One person:** send `ADD +12015551234 Priya`.

Delivery areas are optional. Set them when you have time with `AREA +12015551234 Newport` and the delivery list groups by area.

## 2. Point people who message your own number to the bot

Customers who still message your business number out of habit can be redirected automatically. In the **WhatsApp Business** app → Settings → Business tools:

- **Greeting message** (on): "Hi! Orders now go to our order line 👉 wa.me/<bot number> — just type what you'd like 🙏"
- **Away message** (on, always): same text.
- **Quick replies**: add `/order` with the same text, to send it in two taps.

## 3. Check what the bot is saying

Send `CHATS` to the bot. You get a private link (works for 12 hours, don't forward it) that shows everyone who messaged today:

- **Needs a look**: customers who asked for you, messages the bot couldn't deliver, errors.
- Tap a customer to see the whole conversation, their order, balance and payments, with ✓ sent / ✓✓ delivered / read on each reply.
- `CHATS +12015551234` opens one customer directly.

The page is read-only. To reply, tap **Open in WhatsApp**.

## 4. Share past chats (once, optional)

This helps us test the bot on how your customers really write. In WhatsApp, open a customer chat → their name → **Export chat** → **Without media** → send the file to whoever runs the bot. A handful of busy customers is plenty. Names and numbers are masked before anything is used.

## Why can't the bot read my own WhatsApp chats?

WhatsApp only allows that in a mode called "coexistence", which moves the bot onto your business number. It would also turn off your broadcast lists, which you use for the daily menu, so we're not using it for now.
