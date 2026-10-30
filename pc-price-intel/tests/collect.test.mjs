import test from "node:test";
import assert from "node:assert/strict";
import { inferCondition, parseAlibabaProduct, parseAmazonListings, parseDarazJson, parseMoney, parseOlxListings } from "../tools/collect.mjs";

test("collector money parser keeps currency and handles common PKR listing formats", () => {
  assert.deepEqual(parseMoney("Rs 60,000"), { amount: 60000, currency: "PKR" });
  assert.deepEqual(parseMoney("Rs 1.35 Lac"), { amount: 135000, currency: "PKR" });
  assert.deepEqual(parseMoney("PKR 158,902.23"), { amount: 158902.23, currency: "PKR" });
  assert.deepEqual(parseMoney("US$ 1,234.56"), { amount: 1234.56, currency: "USD" });
  assert.equal(parseMoney("no price here"), null);
});

test("collector condition inference does not turn 'like new' into new", () => {
  assert.equal(inferCondition("Sapphire RX 6600 used"), "used");
  assert.equal(inferCondition("Like new RX 6600"), "used");
  assert.equal(inferCondition("Brand new sealed RX 6600"), "new");
  assert.equal(inferCondition("RX 6600"), null);
});

test("OLX parser extracts price, URL, location and quote without inventing a seller", () => {
  const html = `
    <li title="Sapphire Pulse RX 6600 8GB" aria-label="Listing">
      <a href="/item/sapphire-pulse-rx-6600-8gb-iid-123456">link</a>
      <div aria-label="Price"><span>Rs 60,000</span></div>
      <h2>Sapphire Pulse RX 6600 8GB</h2>
      <span aria-label="Location">Gulberg, Lahore<span>•</span></span>
      <span aria-label="Creation date">2 days ago</span>
    </li>`;
  const rows = parseOlxListings(html, { component: "GPU", level: "online_domestic" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Sapphire Pulse RX 6600 8GB");
  assert.equal(rows[0].price, 60000);
  assert.equal(rows[0].currency, "PKR");
  assert.equal(rows[0].location, "Gulberg, Lahore");
  assert.equal(rows[0].seller, null);
  assert.equal(rows[0].url, "https://www.olx.com.pk/item/sapphire-pulse-rx-6600-8gb-iid-123456");
  assert.match(rows[0].quote, /Rs 60,000/);
});

test("Amazon parser extracts the result title and displayed price as a reference", () => {
  const html = `
    <div data-asin="B09J8VCFWN" data-component-type="s-search-result">
      <h2 aria-label="AMD Radeon RX 6600 Challenger D 8GB"><span>AMD Radeon RX 6600 Challenger D 8GB</span></h2>
      <span class="a-offscreen">PKR 158,902.23</span>
      <a href="/ASRock-6600-8GB-Challenger/dp/B09J8VCFWN/ref=sr_1_1">link</a>
    </div>`;
  const rows = parseAmazonListings(html, { component: "GPU" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "AMD Radeon RX 6600 Challenger D 8GB");
  assert.equal(rows[0].price, 158902);
  assert.equal(rows[0].currency, "PKR");
  assert.equal(rows[0].price_display, "PKR 158,902.23");
  assert.equal(rows[0].evidence, "reference");
  assert.equal(rows[0].level, "unknown");
  assert.equal(rows[0].url, "https://www.amazon.com/ASRock-6600-8GB-Challenger/dp/B09J8VCFWN/ref=sr_1_1");
});

test("Daraz JSON parser keeps seller and location from a saved search payload", () => {
  const data = {
    mods: {
      listItems: [
        {
          name: "AMD Radeon RX 6600 Challenger D 8GB GDDR6 Graphics Card by ASRock",
          price: "55250",
          priceShow: "Rs. 55,250",
          sellerName: "CARD MART",
          location: "Sindh",
          itemUrl: "//www.daraz.pk/products/amd-rx-6600-i1980740091.html",
          itemId: "1980740091",
        },
      ],
    },
  };
  const rows = parseDarazJson(data, { component: "GPU" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 55250);
  assert.equal(rows[0].seller, "CARD MART");
  assert.equal(rows[0].location, "Sindh");
  assert.equal(rows[0].url, "https://www.daraz.pk/products/amd-rx-6600-i1980740091.html");
  assert.equal(rows[0].evidence, "reported");
});

test("Alibaba product parser reads Product JSON-LD and keeps the wholesale range/MOQ visible", () => {
  const html = `
    <html><head><title>Test</title></head><body>
      <p>PKR 21,422-90,726 Minimum order quantity: 5 pieces</p>
      <script type="application/ld+json">
        [{"@context":"https://schema.org/","@type":"Product","name":"Sapphire Radeon RX 6600 8GB Pulse Used Graphics Card - Buy  Product on Alibaba.com","sku":"1600352121473","brand":{"@type":"Brand","name":"Best Source International Co."},"offers":{"@type":"Offer","priceCurrency":"USD","price":"68","availability":"http://schema.org/InStock"}}]
      </script>
    </body></html>`;
  const rows = parseAlibabaProduct(html, {
    component: "GPU",
    url: "https://www.alibaba.com/product-detail/SAPPHIRE-Radeon-RX-6600-8GB-PULSE_1600352121473.html",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Sapphire Radeon RX 6600 8GB Pulse Used Graphics Card");
  assert.equal(rows[0].price, 68);
  assert.equal(rows[0].currency, "USD");
  assert.equal(rows[0].seller, "Best Source International Co.");
  assert.equal(rows[0].condition, "used");
  assert.equal(rows[0].evidence, "reference");
  assert.equal(rows[0].level, "unknown");
  assert.match(rows[0].quote, /page range PKR 21,422-90,726/);
  assert.match(rows[0].quote, /MOQ 5 pieces/);
});
