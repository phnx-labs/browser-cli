# Fill forms and check out

<p align="center"><img src="../assets/readme-features/fill-forms-and-check-out.webp" alt="An agent logs in to Sauce Demo, sorts by price, adds the two cheapest items and completes the order" width="100%"></p>

Type into fields by their label, pick options and click by name. Each action returns once the page has settled, so steps chain in one shell call.

The task: log in to Sauce Demo, add the two cheapest items to the cart, check out as Ada Lovelace and report the totals. Commands from the run:

```sh
browser type "Username" standard_user
browser type "Password" secret_sauce
browser click --text "Login"
browser select "Sort" "Price (low to high)" --snapshot
browser text --css ".inventory_item_price"
browser click 12 && browser click 14
browser type 7 Ada && browser type 8 Lovelace && browser type 9 94107
browser click 3 --snapshot
browser text --grep "Item total|Total"
```

Its answer: item total $17.98, total $19.42 with tax, and the site showed "Thank you for your order!".

- `browser dialog accept|dismiss` answers a `confirm()` or `prompt()`; `browser upload -r <ref> -f <file>` fills a file input.
- To type a password without the agent seeing it, `browser type "Password" --secret <bundle>/<KEY>` reads it from the `secrets` CLI. A bundle named after a site (`stripe.com`) types only into that site.

More: [Driving a page](../guide/driving-a-page.md).
