"use strict";

const CACHE_NAME = "schedule-shell-v0.3.7-b46";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/manifest.json",
  "/favicon.ico",
  "/icon-256.png",
  "/icon-512.png",
  /* 背景照片：预缓存，切视图时不闪 */
  "/bg/bg-month.jpg",
  "/bg/bg-week.jpg",
  "/bg/bg-day.jpg",
  "/bg/bg-notes.jpg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        SHELL_ASSETS.map((url) => cache.add(url).catch(() => undefined))
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.mode === "navigate" || SHELL_ASSETS.includes(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request).then((response) => {
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  if (cached) {
    event.waitUntil(network);
    return cached;
  }

  const response = await network;
  if (response) return response;

  if (request.mode === "navigate") {
    const fallback = await caches.match("/index.html");
    if (fallback) return fallback;
  }
  throw new Error("offline and not cached");
}
