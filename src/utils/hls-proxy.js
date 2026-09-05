const crypto = require("node:crypto");
const { URL } = require("node:url");
const axios = require("axios");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const FALLBACK_SECRET = crypto.randomBytes(32).toString("hex");
const TOKEN_TTL_MS = Number(process.env.HLS_PROXY_TTL_MS || 8 * 60 * 60 * 1000);

function getSecret() {
  return process.env.HLS_PROXY_SECRET || FALLBACK_SECRET;
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(body) {
  return crypto.createHmac("sha256", getSecret()).update(body).digest("base64url");
}

function makeToken(url, referer = "") {
  const payload = {
    u: url,
    r: referer || "",
    e: Date.now() + TOKEN_TTL_MS,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

function readToken(token) {
  if (!token || !token.includes(".")) throw new Error("Token HLS inválido");
  const [body, sig] = token.split(".", 2);
  const expected = sign(body);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Firma HLS inválida");
  }

  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.u || !payload.e || Date.now() > payload.e) {
    throw new Error("Token HLS vencido");
  }

  const parsed = new URL(payload.u);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Protocolo no permitido");
  }

  return payload;
}

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch (_e) {
    return value;
  }
}

function proxyUrlFor(req, targetUrl, referer) {
  const token = makeToken(targetUrl, referer);
  return `${req.protocol}://${req.get("host")}/api/hls/p/${token}`;
}

function rewritePlaylist(text, sourceUrl, req, referer) {
  const lines = text.split(/\r?\n/);
  const rewritten = lines.map((raw) => {
    let line = raw;

    // URI="..." usado por EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, etc.
    line = line.replace(/URI="([^"]+)"/g, (_m, uri) => {
      const target = absoluteUrl(uri, sourceUrl);
      return `URI="${proxyUrlFor(req, target, referer)}"`;
    });

    // URI=... sin comillas.
    line = line.replace(/URI=([^",\s][^,\s]*)/g, (_m, uri) => {
      const target = absoluteUrl(uri, sourceUrl);
      return `URI=${proxyUrlFor(req, target, referer)}`;
    });

    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const target = absoluteUrl(trimmed, sourceUrl);
      return proxyUrlFor(req, target, referer);
    }
    return line;
  });

  return rewritten.join("\n");
}

function upstreamHeaders(referer, req) {
  const headers = {
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    Connection: "keep-alive",
  };

  if (referer) {
    headers.Referer = referer;
    try {
      const ref = new URL(referer);
      headers.Origin = `${ref.protocol}//${ref.host}`;
    } catch (_e) {}
  }

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  return headers;
}

async function proxySignedMedia(req, res, token) {
  const payload = readToken(token);
  const sourceUrl = payload.u;
  const referer = payload.r || "";

  const upstream = await axios.get(sourceUrl, {
    responseType: "stream",
    timeout: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
    headers: upstreamHeaders(referer, req),
    maxRedirects: 5,
    validateStatus: (status) => status >= 200 && status < 400,
  });

  const contentType = String(upstream.headers["content-type"] || "");
  const pathname = new URL(sourceUrl).pathname.toLowerCase();
  const isPlaylist =
    pathname.includes(".m3u8") ||
    contentType.includes("mpegurl") ||
    contentType.includes("application/vnd.apple");

  if (isPlaylist) {
    const chunks = [];
    let total = 0;
    const MAX_PLAYLIST = 6 * 1024 * 1024;

    for await (const chunk of upstream.data) {
      total += chunk.length;
      if (total > MAX_PLAYLIST) {
        upstream.data.destroy();
        throw new Error("Playlist HLS demasiado grande");
      }
      chunks.push(chunk);
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const rewritten = rewritePlaylist(text, sourceUrl, req, referer);

    res.status(upstream.status || 200);
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(rewritten);
    return;
  }

  res.status(upstream.status || 200);

  const passthrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "cache-control",
    "etag",
    "last-modified",
  ];

  for (const header of passthrough) {
    const value = upstream.headers[header];
    if (value !== undefined) res.setHeader(header, value);
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  upstream.data.on("error", () => {
    if (!res.headersSent) res.status(502);
    res.end();
  });
  upstream.data.pipe(res);
}

module.exports = {
  makeToken,
  proxyUrlFor,
  proxySignedMedia,
};
