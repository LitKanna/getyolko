#!/usr/bin/env node
/**
 * Ping IndexNow after site updates so Bing/Yandex crawl getyolko.com faster.
 * Usage: node infra/seo-indexnow.mjs [url ...]   (no args: every URL in sitemap.xml)
 * Key file must live at https://getyolko.com/{INDEXNOW_KEY}.txt
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HOST = "getyolko.com";
const KEY = process.env.INDEXNOW_KEY || "8f3c2a1b9d4e7f6a8b2c1d0e9f8a7b6c";

// Default: every page listed in sitemap.xml.
function sitemapUrls() {
  const xml = readFileSync(fileURLToPath(new URL("../sitemap.xml", import.meta.url)), "utf8");
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  return urls.length ? urls : ["https://getyolko.com/"];
}
const DEFAULT_URLS = sitemapUrls();

const urlList = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;

const body = {
  host: HOST,
  key: KEY,
  keyLocation: `https://${HOST}/${KEY}.txt`,
  urlList,
};

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify(body),
});

const text = await res.text();
if (res.ok || res.status === 202) {
  console.log("IndexNow OK", res.status, urlList.join(", "));
} else {
  console.error("IndexNow failed", res.status, text || res.statusText);
  process.exit(1);
}
