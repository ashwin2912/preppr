# For the kitchen owner

Five minutes of setup on your phone, then the bot takes the morning orders.

The bot runs on **your WhatsApp Business number**, the one customers already message. You keep using the WhatsApp Business app as today and see everything the bot says there. You give the bot commands from your **personal WhatsApp** (your other number).

## 1. Tell the bot who your regulars are

Regulars skip the sign-up questions and can order with one message.

- **Easiest:** from your personal WhatsApp, open the chat with your business number → 📎 (attach) → **Contact** → tick your customers → **Send**. The bot replies "Added 12 customers…". You can do this again any time; it never removes anything.
- **Lots of contacts at once:** export them from your phone (iPhone: Contacts → Lists → select → Export; Android: contacts.google.com → Export → vCard) and send the `.vcf` file to whoever runs the bot.
- **One person:** send `ADD +12015551234 Priya`.

Delivery areas are optional. Set them when you have time with `AREA +12015551234 Newport` and the delivery list groups by area.

## 2. How your day changes

- **Send commands from your personal WhatsApp** to your business number: `MENU`, `SUMMARY`, `PAID` and the rest. Alerts and the morning summary arrive there too.
- **The daily menu:** send `MENU …`, tap **Publish**, then **Send menu**. The bot sends it to customers who asked for it. Broadcast lists stop working on a number connected to the bot, so this replaces them. Add your regulars with `OPTIN <number>`, or `OPTIN ALL` for everyone who already gets your menu (only people who agreed to get messages from you). Customers can reply STOP at any time.
- **Reply to anyone in the app as usual.** When you type in a customer's chat, the bot stays quiet for them for 4 hours. Send `RESUME <number>` to hand back sooner.
- **The bot only answers people who want to order.** Friends, family and suppliers get no bot reply, and their chats stay unread for you.
- **Turn off greeting or away messages** that send customers to another number; they're already in the right chat.
- **Open the WhatsApp Business app at least once every two weeks**, or WhatsApp disconnects the bot.

## 3. Check what the bot is saying

Send `CHATS` from your personal WhatsApp to your business number. You get a private link (works for 12 hours, don't forward it) that shows everyone who messaged today:

- **Needs a look**: customers who asked for you, messages the bot couldn't deliver, errors.
- Tap a customer to see the whole conversation, their order, balance and payments, with ✓ sent / ✓✓ delivered / read on each reply.
- `CHATS +12015551234` opens one customer directly.

The page is read-only. To reply, open the chat in your WhatsApp Business app. What you typed in the app shows as "you, in the app".

## 4. Share past chats (once, optional)

This helps us test the bot on how your customers really write. In WhatsApp, open a customer chat → their name → **Export chat** → **Without media** → send the file to whoever runs the bot. A handful of busy customers is plenty. Names and numbers are masked before anything is used.

## If the bot is down

Nothing changes for customers: they're in your normal chat. Reply to orders by hand in the WhatsApp Business app as you did before the bot.
