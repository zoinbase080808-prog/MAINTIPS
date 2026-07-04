const express = require("express");

const app = express();
const cache = new Map();
const CACHE_MS = 120000;

app.use(express.json({ limit: "1mb" }));

function cacheGet(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(key, value) {
  cache.set(key, { time: Date.now(), value });
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "MAINTIPS-Roblox-Proxy/1.0",
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status + " from " + url);
  }

  return response.json();
}

function normalizeAssetType(assetTypeId) {
  if (assetTypeId === 2) return "TShirt";
  if (assetTypeId === 11) return "Shirt";
  if (assetTypeId === 12) return "Pants";
  return null;
}

function addUnique(items, seen, item) {
  if (!item || !item.id || seen[item.id]) return;
  if (!item.price || item.price <= 0) return;
  seen[item.id] = true;
  items.push(item);
}

async function getUser(userId) {
  const data = await getJson("https://users.roblox.com/v1/users/" + encodeURIComponent(userId));
  return {
    id: data.id || Number(userId),
    name: data.name || String(userId),
    displayName: data.displayName || data.name || String(userId)
  };
}

async function getUserGames(userId) {
  const games = [];
  const seen = {};
  const filters = ["2", "Public"];

  for (const filter of filters) {
    let cursor = "";

    for (let page = 0; page < 3; page++) {
      let url = "https://games.roblox.com/v2/users/" + encodeURIComponent(userId)
        + "/games?accessFilter=" + filter
        + "&sortOrder=Asc&limit=50";

      if (cursor) url += "&cursor=" + encodeURIComponent(cursor);

      const data = await getJson(url);
      const list = data.data || [];

      for (const game of list) {
        const universeId = game.id || game.universeId;
        if (universeId && !seen[universeId]) {
          seen[universeId] = true;
          games.push(universeId);
        }
      }

      cursor = data.nextPageCursor;
      if (!cursor) break;
    }

    if (games.length > 0) break;
  }

  return games;
}

async function getGamepasses(universeId) {
  const items = [];
  let cursor = "";

  for (let page = 0; page < 3; page++) {
    let url = "https://games.roblox.com/v1/games/" + encodeURIComponent(universeId)
      + "/game-passes?limit=100&sortOrder=Asc";

    if (cursor) url += "&cursor=" + encodeURIComponent(cursor);

    const data = await getJson(url);
    const list = data.data || [];

    for (const pass of list) {
      if (pass.id && pass.price) {
        items.push({
          id: pass.id,
          name: pass.name || "Gamepass",
          price: pass.price,
          assetType: "Gamepass"
        });
      }
    }

    cursor = data.nextPageCursor;
    if (!cursor) break;
  }

  return items;
}

async function getCatalogItems(username) {
  const items = [];
  const url = "https://catalog.roblox.com/v1/search/items"
    + "?creatorName=" + encodeURIComponent(username)
    + "&creatorType=User"
    + "&salesTypeFilter=1"
    + "&limit=100";

  const data = await getJson(url);
  const list = data.data || [];

  for (const item of list) {
    const assetType = normalizeAssetType(item.assetType || item.assetTypeId);
    if (assetType && item.id && item.price) {
      items.push({
        id: item.id,
        name: item.name || assetType,
        price: item.price,
        assetType
      });
    }
  }

  return items;
}

async function buildDonationItems(userId) {
  const cacheKey = "items:" + userId;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const user = await getUser(userId);
  const items = [];
  const seen = {};

  try {
    const games = await getUserGames(user.id);
    for (const universeId of games) {
      const passes = await getGamepasses(universeId);
      for (const item of passes) addUnique(items, seen, item);
    }
  } catch (error) {
    console.warn("[passes]", error.message);
  }

  try {
    const clothes = await getCatalogItems(user.name);
    for (const item of clothes) addUnique(items, seen, item);
  } catch (error) {
    console.warn("[catalog]", error.message);
  }

  items.sort((a, b) => {
    if (a.price === b.price) return String(a.name).localeCompare(String(b.name));
    return a.price - b.price;
  });

  const result = {
    ok: true,
    userId: user.id,
    username: user.name,
    displayName: user.displayName,
    items
  };

  cacheSet(cacheKey, result);
  return result;
}

app.get("/", (req, res) => {
  res.type("text/plain").send("MAINTIPS proxy is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/items/:userId", async (req, res) => {
  try {
    const result = await buildDonationItems(req.params.userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      items: []
    });
  }
});

app.get("/donate_items.json", async (req, res) => {
  const userId = req.query.userId || req.query.userid;
  if (!userId) {
    res.json({ users: {} });
    return;
  }

  try {
    const result = await buildDonationItems(userId);
    res.json({
      users: {
        [String(userId)]: {
          items: result.items
        }
      }
    });
  } catch (error) {
    res.status(500).json({ users: {}, error: error.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("MAINTIPS proxy running on port " + port);
});
