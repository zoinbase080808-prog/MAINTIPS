const express = require("express");

const app = express();
const cache = new Map();
const CACHE_MS = 120000;

const MANUAL_ITEMS = {
  users: {
    // Example:
    // "145772": {
    //   items: [
    //     { id: 123456789, name: "10 Robux", price: 10, assetType: "Gamepass" }
    //   ]
    // }
  }
};

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

async function getJsonFirst(urls, debug, label) {
  let lastError = null;

  for (const url of urls) {
    try {
      const data = await getJson(url);
      if (debug) {
        debug.steps.push({ label, url, ok: true });
      }
      return data;
    } catch (error) {
      lastError = error;
      if (debug) {
        debug.steps.push({ label, url, ok: false, error: error.message });
      }
    }
  }

  throw lastError || new Error("All URLs failed for " + label);
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

async function getUser(userId, debug) {
  const encoded = encodeURIComponent(userId);
  const data = await getJsonFirst([
    "https://users.roblox.com/v1/users/" + encoded,
    "https://users.roproxy.com/v1/users/" + encoded
  ], debug, "user");

  return {
    id: data.id || Number(userId),
    name: data.name || String(userId),
    displayName: data.displayName || data.name || String(userId)
  };
}

async function getUserGames(userId, debug) {
  const games = [];
  const seen = {};
  const filters = ["2", "Public"];

  for (const filter of filters) {
    let cursor = "";

    for (let page = 0; page < 3; page++) {
      let path = "/v2/users/" + encodeURIComponent(userId)
        + "/games?accessFilter=" + filter
        + "&sortOrder=Asc&limit=50";

      if (cursor) path += "&cursor=" + encodeURIComponent(cursor);

      const data = await getJsonFirst([
        "https://games.roblox.com" + path,
        "https://games.roproxy.com" + path
      ], debug, "games");

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

async function getGamepasses(universeId, debug) {
  const items = [];
  let cursor = "";

  for (let page = 0; page < 3; page++) {
    let path = "/v1/games/" + encodeURIComponent(universeId)
      + "/game-passes?limit=100&sortOrder=Asc";

    if (cursor) path += "&cursor=" + encodeURIComponent(cursor);

    const data = await getJsonFirst([
      "https://games.roblox.com" + path,
      "https://games.roproxy.com" + path
    ], debug, "gamepasses");

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

async function getProductInfo(assetId, debug) {
  const encoded = encodeURIComponent(assetId);
  return getJsonFirst([
    "https://api.roblox.com/marketplace/productinfo?assetId=" + encoded,
    "https://api.roproxy.com/marketplace/productinfo?assetId=" + encoded
  ], debug, "productinfo");
}

async function getCatalogItems(username, debug) {
  const items = [];
  const path = "/v1/search/items"
    + "?creatorName=" + encodeURIComponent(username)
    + "&creatorType=User"
    + "&salesTypeFilter=1"
    + "&limit=100";

  const data = await getJsonFirst([
    "https://catalog.roblox.com" + path,
    "https://catalog.roproxy.com" + path
  ], debug, "catalog");

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
    } else if (item.id) {
      try {
        const info = await getProductInfo(item.id, debug);
        const detailedType = normalizeAssetType(info.AssetTypeId || info.assetTypeId);
        const price = info.PriceInRobux || info.price;
        if (detailedType && price) {
          items.push({
            id: info.AssetId || item.id,
            name: info.Name || item.name || detailedType,
            price,
            assetType: detailedType
          });
        }
      } catch (error) {
        if (debug) {
          debug.steps.push({ label: "productinfo-skip", id: item.id, ok: false, error: error.message });
        }
      }
    }
  }

  return items;
}

function getManualItems(userId, username) {
  const lists = [];
  const userKey = String(userId);

  if (MANUAL_ITEMS.users[userKey]) lists.push(MANUAL_ITEMS.users[userKey]);
  if (username && MANUAL_ITEMS.users[username]) lists.push(MANUAL_ITEMS.users[username]);

  const items = [];
  for (const list of lists) {
    for (const item of (list.items || [])) {
      if (item.id && item.price && item.assetType) {
        items.push({
          id: Number(item.id),
          name: String(item.name || item.assetType),
          price: Number(item.price),
          assetType: String(item.assetType)
        });
      }
    }
  }
  return items;
}

async function buildDonationItems(userId, withDebug = false) {
  const cacheKey = "items:" + userId;
  const cached = cacheGet(cacheKey);
  if (cached && !withDebug) return cached;

  const debug = { steps: [] };
  const user = await getUser(userId, debug);
  const items = [];
  const seen = {};

  try {
    const games = await getUserGames(user.id, debug);
    debug.gamesFound = games.length;

    for (const universeId of games) {
      const passes = await getGamepasses(universeId, debug);
      for (const item of passes) addUnique(items, seen, item);
    }
  } catch (error) {
    console.warn("[passes]", error.message);
    debug.passesError = error.message;
  }

  try {
    const clothes = await getCatalogItems(user.name, debug);
    debug.clothingFound = clothes.length;

    for (const item of clothes) addUnique(items, seen, item);
  } catch (error) {
    console.warn("[catalog]", error.message);
    debug.catalogError = error.message;
  }

  const manual = getManualItems(user.id, user.name);
  debug.manualFound = manual.length;
  for (const item of manual) {
    addUnique(items, seen, item);
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

  if (withDebug) {
    result.debug = debug;
  } else {
    cacheSet(cacheKey, result);
  }

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

app.get("/debug/:userId", async (req, res) => {
  try {
    const result = await buildDonationItems(req.params.userId, true);
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
