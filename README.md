# Sikka

**An Indian shopkeeper accepts USDC through one Telegram chat and one printed QR.**

A customer scans the shop's QR, picks ₹100 and pays USDC on Base from their own wallet. The Sikka agent checks the shop's guardrails, creates a Bitrefill invoice for a PhonePe gift card, sees the payment land, and delivers the card to the owner on Telegram. A browser "soundbox" on the counter then announces *"crypto se 100 rupaye prapt hue"*.

The owner never touches a crypto wallet, and the customer never installs an app. No human is involved at checkout.

Built for Free Society Hack, Agentic Commerce (Bitrefill) track.

## Lanes

- **1. Rails & guardrails:** per-sale, daily and agent-wide caps, a balance floor and owner approvals, all enforced in code.
- **3. No prompt required:** an on-chain USDC transfer triggers the purchase.
- **4. Home-cooked commerce:** a local shop is the user.

## Demo video

**TODO: add the video link.**

## Real purchase invoice ID

**TODO: add the Bitrefill invoice ID from the real purchase.**

## Bitrefill touchpoints

- **REST API v2:** `/products`, `/products/search`, `/accounts/balance`, `/invoices` with `usdc_base` (direct) or `balance` + `auto_pay` (relay), `/invoices/{id}`, `/orders/{id}`
- **Test products** during development: `test-gift-card-code`, and `test-gift-card-code-fail` for the failure path
- **Docs** while coding

**Built:** payment page, direct invoice payments, Base USDC watcher with unique-amount matching, guardrail engine, Telegram merchant agent, soundbox.

**Reused:** Bitrefill catalog and fulfillment, PhonePe gift card redemption, grammY, viem.

## Guardrails

- **Per purchase:** the shop's per-sale cap (default ₹500). Anything above needs the **shop owner's approval** in Telegram. Hard ceiling: ₹5,000 per sale and `AGENT_MAX_PER_PURCHASE_USD` ($60).
- **Per day:** the shop's daily cap (default ₹2,000), plus an agent-wide `AGENT_MAX_DAILY_USD` ($10 during the hackathon) across all shops.
- **Balance floor (relay mode):** no sale starts if the Bitrefill balance would fall below $2. Direct mode doesn't touch the balance, so the floor doesn't apply there.
- **Checked before the customer pays:** guardrails run when the sale is created, before any payment address is shown. Relay mode checks again right before buying.
- **Who approves above the limit:** the shop owner, using the Approve/Reject buttons. Only the operator (by editing env) can raise the agent-wide caps.
- **No double buys:** one invoice per sale, saved before polling; guarded state transitions; in relay mode, each on-chain log is handled once.
- **Card codes:** stored only until the owner taps "Claimed", then wiped. Never returned by the public API, logged or sent to the LLM.
- **The LLM can't spend:** it answers the owner's questions with read-only tools plus `update_caps`, limited to the same ceilings. Every money step is deterministic code.

**Known MVP gaps:** Sikka briefly holds customer USDC in relay mode. Direct mode refunds go to the operator's address, then back to the customer by hand. A direct payment made after a sale expires isn't tracked. Dev, admin, soundbox and summary routes have no auth, so anyone with a shop's link can see its daily total. Codes are stored in plaintext until claimed. Refunds are manual. Abandoned sales hold their share of the daily cap until they expire.

## Run it in under 15 minutes

**You need:** Node 20+, a Bitrefill account with an API key and balance, a Telegram bot token from @BotFather, a Base address to receive USDC, and an [ngrok](https://ngrok.com) static domain. An OpenAI-compatible LLM key (Groq or Gemini free tier) is optional: without one, the bot uses commands.

```bash
git clone https://github.com/TathagatGupta98/Bitrefill-Crypto-payments-like-UPI.git
cd Bitrefill-Crypto-payments-like-UPI
cp .env.example .env
```

Fill in these values in `.env`:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | `https://<your-domain>` |
| `BITREFILL_API_KEY` | From Bitrefill → Account → Developers |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `RECEIVE_ADDRESS` | Your Base address |
| `LLM_API_KEY`, `LLM_MODEL` | Optional, for free-text chat |

```bash
npm i
npm run smoke                      # balance, PhonePe packages and a free test card
ngrok http --url=<your-domain> 3000
npm run dev                        # in a second terminal
```

Send `/start` to your bot, answer three questions, and open the QR it sends.

Everything stays free while `BITREFILL_TEST_MODE=true`. With `DEV_MODE=true`, the pay page has a "Simulate payment" link and `/admin` lists sales.

**To go live:** run `npm run find-product` to confirm the product and packages, then set `PAY_MODE=direct` and `BITREFILL_TEST_MODE=false`. Real purchases can't be simulated in this mode, and the app won't start with direct mode and test mode together, because Bitrefill charges real USDC even for test cards.

**To see the failure path:** in relay test mode, set `BITREFILL_TEST_PRODUCT=test-gift-card-code-fail`. The purchase fails and the owner is told a refund is needed.

## Architecture

One Node process, SQLite, and plain HTML pages with no build step.

There are two payment modes, set by `PAY_MODE`.

**Direct (used for real purchases):** the customer pays Bitrefill's invoice, so Sikka never holds funds.

```
Customer picks ₹100 --> guardrails OK? --> POST /v2/invoices {payment_method: usdc_base}
                                                  |
Customer wallet --USDC on Base--> the invoice's own payment address
                                                  |
                      poll invoice -> paid -> all_delivered -> GET /v2/orders/{id}
                                                  |
      Telegram: card code + PIN to the owner;  SSE: soundbox speaks;  pay page goes green
```

**Relay (free rehearsal with test cards):** the customer pays Sikka, and Sikka buys from its Bitrefill balance.

```
Customer wallet --USDC on Base--> RECEIVE_ADDRESS
                                        |
                       chain watcher sees the Transfer and matches the amount to a sale
                                        |
            guardrails OK? --> POST /v2/invoices {payment_method: balance, auto_pay: true}
                                        |
                  poll invoice -> all_delivered -> GET /v2/orders/{id}
                                        |
         Telegram: card code + PIN to the owner;  SSE: soundbox speaks;  pay page goes green
```

In relay mode, each sale gets a unique USDC amount, such as `1.1849`, so a payment needs no memo: the watcher matches on the exact amount and the receive address.

**Why direct is the live path:** the hackathon's $25 credit is held in USD, and we couldn't spend it through the REST API. `payment_method: balance` returned `balance_too_low`, with or without `balance_currency: USD`. See [FEEDBACK.md](FEEDBACK.md).

| File | Job |
|---|---|
| `src/sales.js` | Creates sales, picks unique amounts, expires unpaid sales |
| `src/chain.js` | Watches Base for USDC transfers |
| `src/guardrails.js` | Caps and the balance floor |
| `src/fulfill.js` | Paid sale → Bitrefill invoice → order → delivery |
| `src/bot.js` | Telegram onboarding, delivery, approvals and commands |
| `src/agent.js` | LLM tool loop for the owner's free-text questions |
| `public/` | Pay page, soundbox, printable standee, admin |

## Limits and next steps

- A markup for the shop and automatic refunds in direct mode
- Lightning, WhatsApp and odd amounts
- An ESP32 hardware soundbox
- Bitrefill Business API for production

## Feedback

See [FEEDBACK.md](FEEDBACK.md).
