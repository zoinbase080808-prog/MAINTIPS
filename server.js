const express = require("express");

const app = express();
const cache = new Map();
const CACHE_MS = 2 * 60 * 1000;

// Change this if your Korone/Pekora domain is different.
// No Roblox or roproxy domains are used in this server.
const PEKORA_BASE_URL = process.env.PEKORA_BASE_URL || "https://pekora.zip";

app.use(express.json({ limit: "1mb" }));

function joinUrl(base, path) {
  return base.replace(/\/+$/, "") + "/" + String(path).replace(/^\/+/, "");
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.time > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  cache.set(key, { time: Date.now(), value });
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json,text/html,*/*",
      "User-Agent": "Mozilla/5.0 MAINTIPS-Pekora-Booth/1.0"
    }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  return response.text();
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function fetchAny(path, debug, label) {
  const url = joinUrl(PEKORA_BASE_URL, path);

  try {
    const text = await fetchText(url);
    debug.steps.push({ label, ok: true, url });
    return { url, text, json: tryJson(text) };
  } catch (error) {
    debug.steps.push({ label, ok: false, url, error: error.message });
    return null;
  }
}

function assetTypeName(value) {
  const text = String(value || "").toLowerCase();
  const number = Number(value);

  if (number === 2 || text === "tshirt" || text === "t-shirt") return "TShirt";
  if (number === 11 || text === "shirt") return "Shirt";
  if (number === 12 || text === "pants") return "Pants";
  if (number === 34 || text === "gamepass" || text === "game pass") return "Gamepass";

  return null;
}

function readId(raw) {
  return Number(
    raw.id ||
    raw.Id ||
    raw.assetId ||
    raw.AssetId ||
    raw.AssetID ||
    raw.gamepassId ||
    raw.GamePassId ||
    raw.GamepassId
  );
}

function readPrice(raw) {
  return Number(
    raw.price ||
    raw.Price ||
    raw.robux ||
    raw.Robux ||
    raw.PriceInRobux ||
    raw.priceInRobux ||
    raw.LowestPrice ||
    raw.lowestPrice
  );
}

function readType(raw) {
  return assetTypeName(
    raw.assetType ||
    raw.AssetType ||
    raw.assetTypeId ||
    raw.assetTypeID ||
    raw.AssetTypeId ||
    raw.AssetTypeID ||
    raw.type ||
    raw.Type
  );
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = readId(raw);
  const price = readPrice(raw);
  const assetType = readType(raw);

  if (!id || !price || price <= 0 || !assetType) return null;

  return {
    id,
    name: String(raw.name || raw.Name || raw.title || raw.Title || assetType),
    price,
    assetType
  };
}

function addItem(items, seen, item) {
  if (!item || !item.id || !item.price || !item.assetType) return;
  if (seen[item.id]) return;
  seen[item.id] = true;
  items.push(item);
}

function collectFromJson(json, items, seen) {
  if (!json) return;

  const lists = [];

  if (Array.isArray(json)) lists.push(json);
  if (Array.isArray(json.data)) lists.push(json.data);
  if (Array.isArray(json.Data)) lists.push(json.Data);
  if (Array.isArray(json.items)) lists.push(json.items);
  if (Array.isArray(json.Items)) lists.push(json.Items);
  if (Array.isArray(json.results)) lists.push(json.results);
  if (Array.isArray(json.Results)) lists.push(json.Results);

  for (const list of lists) {
    for (const raw of list) {
      addItem(items, seen, normalizeItem(raw));
    }
  }
}

function collectIdsFromHtml(html) {
  const ids = {};
  const patterns = [
    /\/catalog\/(\d+)/gi,
    /\/library\/(\d+)/gi,
    /assetId=(\d+)/gi,
    /assetid=(\d+)/gi,
    /data-asset-id=["']?(\d+)/gi,
    /data-item-id=["']?(\d+)/gi
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      ids[Number(match[1])] = true;
    }
  }

  return Object.keys(ids).map(Number);
}

async function getUser(userId, debug) {
  const paths = [
    "/api/users/" + encodeURIComponent(userId),
    "/users/" + encodeURIComponent(userId),
    "/users/" + encodeURIComponent(userId) + "/profile"
  ];

  for (const path of paths) {
    const result = await fetchAny(path, debug, "user");
    if (!result) continue;

    if (result.json) {
      const name = result.json.username || result.json.Username || result.json.name || result.json.Name;
      const displayName = result.json.displayName || result.json.DisplayName || name;
      if (name) {
        return {
          id: Number(userId),
          name: String(name),
          displayName: String(displayName || name)
        };
      }
    }

    const titleMatch = result.text.match(/<title[^>]*>([^<]+)/i);
    const nameMatch = result.text.match(/class=["'][^"']*(username|profile-name)[^"']*["'][^>]*>([^<]+)/i);
    if (nameMatch || titleMatch) {
      const name = String((nameMatch && nameMatch[2]) || titleMatch[1]).replace(/\s*-\s*.*/, "").trim();
      if (name) {
        return {
          id: Number(userId),
          name,
          displayName: name
        };
      }
    }
  }

  return {
    id: Number(userId),
    name: String(userId),
    displayName: String(userId)
  };
}

async function getProductInfo(assetId, debug) {
  const paths = [
    "/marketplace/productinfo?assetId=" + encodeURIComponent(assetId),
    "/api/marketplace/productinfo?assetId=" + encodeURIComponent(assetId),
    "/v1/marketplace/productinfo?assetId=" + encodeURIComponent(assetId),
    "/catalog/" + encodeURIComponent(assetId)
  ];

  for (const path of paths) {
    const result = await fetchAny(path, debug, "product-info");
    if (!result) continue;

    if (result.json) {
      const item = normalizeItem(result.json);
      if (item) return item;
    }

    const priceMatch = result.text.match(/(?:R\$|Robux|Price)[^\d]{0,20}(\d+)/i);
    const nameMatch = result.text.match(/<title[^>]*>([^<]+)/i);
    const typeMatch = result.text.match(/(Gamepass|Game Pass|T-Shirt|TShirt|Shirt|Pants)/i);
    const assetType = typeMatch && assetTypeName(typeMatch[1]);
    const price = priceMatch && Number(priceMatch[1]);

    if (assetType && price && price > 0) {
      return {
        id: Number(assetId),
        name: String(nameMatch ? nameMatch[1] : assetType).replace(/\s*-\s*.*/, "").trim(),
        price,
        assetType
      };
    }
  }

  return null;
}

async function getItemsByCreator(user, debug) {
  const items = [];
  const seen = {};
  const id = encodeURIComponent(user.id);
  const name = encodeURIComponent(user.name);

  const paths = [
    "/catalog/json?CreatorID=" + id,
    "/catalog/json?creatorId=" + id,
    "/catalog/json?CreatorName=" + name,
    "/catalog/json?creatorName=" + name,
    "/catalog?CreatorID=" + id,
    "/catalog?creatorId=" + id,
    "/catalog?CreatorName=" + name,
    "/catalog?creatorName=" + name,
    "/users/" + id + "/inventory",
    "/users/" + id + "/creations",
    "/users/" + id + "/profile"
  ];

  for (const path of paths) {
    const result = await fetchAny(path, debug, "creator-items");
    if (!result) continue;

    collectFromJson(result.json, items, seen);

    if (items.length === 0 && result.text) {
      const ids = collectIdsFromHtml(result.text);
      for (const assetId of ids.slice(0, 80)) {
        const item = await getProductInfo(assetId, debug);
        addItem(items, seen, item);
      }
    }
  }

  return items;
}

async function buildItems(userId, debugMode) {
  const key = "items:" + userId;
  const cached = cacheGet(key);
  if (cached && !debugMode) return cached;

  const debug = {
    baseUrl: PEKORA_BASE_URL,
    userId: Number(userId),
    steps: []
  };

  const user = await getUser(userId, debug);
  const items = await getItemsByCreator(user, debug);

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
    cacheSet(key, result);
  }

  return result;
}

app.get("/", (req, res) => {
  res.type("text/plain").send("MAINTIPS Pekora booth proxy is running");
});

app.get("/health", (req, res) => {
  res.json({ ok: true, baseUrl: PEKORA_BASE_URL, time: new Date().toISOString() });
});

app.get("/items/:userId", async (req, res) => {
  try {
    res.json(await buildItems(req.params.userId, false));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, items: [] });
  }
});

app.get("/debug/:userId", async (req, res) => {
  try {
    res.json(await buildItems(req.params.userId, true));
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message, items: [] });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("MAINTIPS Pekora booth proxy running on port " + port);
});
