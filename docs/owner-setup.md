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

## If the bot is on your own business number

Some kitchens run the bot on the number customers already message (WhatsApp calls this "coexistence"). Then:

- **Send commands from your personal WhatsApp**, not the business phone: MENU, SUMMARY, PAID and the rest go from your personal number to your business number. Alerts and the morning summary arrive there too.
- **Section 2 isn't needed**: customers are already in the right chat. Turn off any greeting or away message that sends them elsewhere.
- **Reply to anyone in the app as usual.** When you type in a customer's chat, the bot stays quiet for them for 4 hours. Send `RESUME <number>` to hand back sooner.
- **The bot only answers people who want to order.** Friends, family and suppliers get no bot reply, and their chats stay unread for you.
- **Broadcast lists stop working.** After you tap Publish, tap **Send menu**: the bot sends the menu to customers who asked for it. Add your regulars with `OPTIN <number>`, or `OPTIN ALL` for everyone who already gets your menu. Customers can reply STOP at any time.
- **Open the WhatsApp Business app at least once every two weeks**, or WhatsApp disconnects the bot.
