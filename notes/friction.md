# Friction notes

- Docs disagree on the base URL: the OpenAPI spec says `api-bitrefill.com`, the Quickstart says `api.bitrefill.com`.
- Docs disagree on `redemption_info`: a string in the OpenAPI spec, an object in Core Concepts and the Quickstart.
- Docs disagree on `packages`: a single object with `id` in the OpenAPI spec, an array with `package_id` in the guides. `package_id` is typed as a number in the spec but is a string in the guides.
- `GET /ping` is documented with `message` at the top level in the spec, but under `data` in the Quickstart.
- `country` is documented on `GET /products` but not on `GET /products/search`.
- `Retry-After` isn't documented; the rate-limit guide says to wait for `X-RateLimit-Reset`.
- `GET /invoices/{id}` allows 60 calls per 10 minutes, so polling every 2 s can use the whole limit on one sale.
- Error bodies vary by endpoint: `{ error }` on search, `{ message, error_code }` on invoices.
- Not Bitrefill: the public `mainnet.base.org` RPC returned 429 on every `eth_getLogs` (other calls worked), so the watcher now defaults to `base-rpc.publicnode.com`.
