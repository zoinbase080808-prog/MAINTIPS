const express = require("express");

const app = express();
const cache = new Map();
const CACHE_MS = 2 * 60 * 1000;

app.use(express.json({ limit: "1mb" }));

function getFromCache(key) {
  const cached = cache.get(key);
  if (!cached) return null;

  if (Date.now() - cached.time > CACHE_MS) {
    cache.delete(key);
    return null;
  }

  return cached.value;
}

function setCache(key, value) {
  cache.set(key, {
    time: Date.now(),
    value
  });
}

async function fetchJson(url, debug, label) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "MAINTIPS-Auto-Booth/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(label + " HTTP " + response.status);
  }

  return response.json();
}

async function fetchFirst(urls, debug, label) {
  let lastError = null;

  for (const url of urls) {
    try {
      const data = await fetchJson(url, debug, label);
      debug.steps.push({ label, ok: true, url });
      return data;
    } catch (error) {
      lastError = error;
      debug.steps.push({ label, ok: false, url, error: error.message });
    }
  }

  throw lastError || new Error(label + " failed");
}

function assetTypeName(assetTypeId) {
  const id = Number(assetTypeId);
  if (id === 2) return "TShirt";
  if (id === 11) return "Shirt";
  if (id === 12) return "Pants";
  return null;
}

function addItem(items, seen, item) {
  if (!item) return;

  const id = Number(item.id);
  const price = Number(item.price);
  const assetType = String(item.assetType || "");

  if (!id || !price || price <= 0 || !assetType) return;
  if (seen[id]) return;

  seen[id] = true;
  items.push({
    id,
    name: String(item.name || assetType),
    price,
    assetType
  });
}

async function getUser(userId, debug) {
  const id = encodeURIComponent(String(userId));
  const data = await fetchFirst([
    "https://users.roblox.com/v1/users/" + id,
    "https://users.roproxy.com/v1/users/" + id
  ], debug, "user");

  return {
    id: Number(data.id || userId),
    name: String(data.name || userId),
    displayName: String(data.displayName || data.name || userId)
  };
}

async function getUserGames(userId, debug) {
  const games = [];
  const seen = {};
  const filters = ["2", "Public"];

  for (const filter of filters) {
    let cursor = "";

    for (let page = 0; page < 5; page++) {
      let path = "/v2/users/" + encodeURIComponent(String(userId))
        + "/games?accessFilter=" + encodeURIComponent(filter)
        + "&sortOrder=Asc&limit=50";

      if (cursor) {
        path += "&cursor=" + encodeURIComponent(cursor);
      }

      const data = await fetchFirst([
        "https://games.roblox.com" + path,
        "https://games.roproxy.com" + path
      ], debug, "user-games");

      for (const game of data.data || []) {
        const universeId = Number(game.id || game.universeId);
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

  debug.gamesFound = games.length;
  return games;
}

async function getGamepassesForUniverse(universeId, debug) {
  const result = [];
  let cursor = "";

  for (let page = 0; page < 5; page++) {
    let path = "/v1/games/" + encodeURIComponent(String(universeId))
      + "/game-passes?limit=100&sortOrder=Asc";

    if (cursor) {
      path += "&cursor=" + encodeURIComponent(cursor);
    }

    const data = await fetchFirst([
      "https://games.roblox.com" + path,
      "https://games.roproxy.com" + path
    ], debug, "game-passes");

    for (const pass of data.data || []) {
      result.push({
        id: pass.id,
        name: pass.name || "Gamepass",
        price: pass.price,
        assetType: "Gamepass"
      });
    }

    cursor = data.nextPageCursor;
    if (!cursor) break;
  }

  return result;
}

async function getProductInfo(assetId, debug) {
  const id = encodeURIComponent(String(assetId));
  return fetchFirst([
    "https://api.roblox.com/marketplace/productinfo?assetId=" + id,
    "https://api.roproxy.com/marketplace/productinfo?assetId=" + id
  ], debug, "product-info");
}

async function getClothingByCreator(username, debug) {
  const result = [];
  const creator = encodeURIComponent(username);

  const urls = [
    "https://catalog.roblox.com/v1/search/items?category=Clothing&creatorName=" + creator + "&creatorType=User&salesTypeFilter=1&limit=100",
    "https://catalog.roblox.com/v1/search/items?Category=3&CreatorName=" + creator + "&CreatorType=User&SalesTypeFilter=1&Limit=100",
    "https://catalog.roproxy.com/v1/search/items?category=Clothing&creatorName=" + creator + "&creatorType=User&salesTypeFilter=1&limit=100",
    "https://catalog.roproxy.com/v1/search/items?Category=3&CreatorName=" + creator + "&CreatorType=User&SalesTypeFilter=1&Limit=100"
  ];

  let data = null;
  for (const url of urls) {
    try {
      data = await fetchJson(url, debug, "catalog");
      debug.steps.push({ label: "catalog", ok: true, url });
      break;
    } catch (error) {
      debug.steps.push({ label: "catalog", ok: false, url, error: error.message });
    }
  }

  if (!data || !data.data) {
    debug.clothingFound = 0;
    return result;
  }

  for (const item of data.data) {
    const directType = assetTypeName(item.assetType || item.assetTypeId);
    const directPrice = Number(item.price || item.lowestPrice || 0);

    if (item.id && directType && directPrice > 0) {
      result.push({
        id: item.id,
        name: item.name || directType,
        price: directPrice,
        assetType: directType
      });
      continue;
    }

    if (!item.id) continue;

    try {
      const info = await getProductInfo(item.id, debug);
      const detailedType = assetTypeName(info.AssetTypeId || info.assetTypeId);
      const detailedPrice = Number(info.PriceInRobux || info.price || 0);

      if (detailedType && detailedPrice > 0 && info.IsForSale !== false) {
        result.push({
          id: info.AssetId || item.id,
          name: info.Name || item.name || detailedType,
          price: detailedPrice,
          assetType: detailedType
        });
      }
    } catch (error) {
      debug.steps.push({
        label: "product-info-skip",
        ok: false,
        id: item.id,
        error: error.message
      });
    }
  }

  debug.clothingFound = result.length;
  return result;
}

async function buildItems(userId, debugMode) {
  const cacheKey = "user:" + userId;
  const cached = getFromCache(cacheKey);
  if (cached && !debugMode) return cached;

  const debug = {
    userId: Number(userId),
    steps: [],
    gamesFound: 0,
    gamepassesFound: 0,
    clothingFound: 0
  };

  const user = await getUser(userId, debug);
  const items = [];
  const seen = {};

  try {
    const games = await getUserGames(user.id, debug);

    for (const universeId of games) {
      try {
        const passes = await getGamepassesForUniverse(universeId, debug);
        debug.gamepassesFound += passes.length;
        for (const pass of passes) {
          addItem(items, seen, pass);
        }
      } catch (error) {
        debug.steps.push({
          label: "game-passes-universe-failed",
          ok: false,
          universeId,
          error: error.message
        });
      }
    }
  } catch (error) {
    debug.steps.push({ label: "all-game-passes-failed", ok: false, error: error.message });
  }

  try {
    const clothing = await getClothingByCreator(user.name, debug);
    for (const item of clothing) {
      addItem(items, seen, item);
    }
  } catch (error) {
    debug.steps.push({ label: "all-clothing-failed", ok: false, error: error.message });
  }

  items.sort((a, b) => {
    if (a.price === b.price) return a.name.localeCompare(b.name);
    return a.price - b.price;
  });

  const result = {
    ok: true,
    userId: user.id,
    username: user.name,
    displayName: user.displayName,
    items
  };

  if (debugMode) {
    result.debug = debug;
  } else {
    setCache(cacheKey, result);
  }

  return result;
}

app.get("/", (req, res) => {
  res.type("text/plain").send("MAINTIPS auto booth proxy is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get("/items/:userId", async (req, res) => {
  try {
    const result = await buildItems(req.params.userId, false);
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
    const result = await buildItems(req.params.userId, true);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      items: []
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("MAINTIPS auto booth proxy running on port " + port);
});
