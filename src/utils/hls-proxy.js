const crypto = require("node:crypto");
const { URL } = require("node:url");
const axios = require("axios");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

const FALLBACK_SECRET = crypto.randomBytes(32).toString("hex");

const TOKEN_TTL_MS = Number(
  process.env.HLS_PROXY_TTL_MS || 8 * 60 * 60 * 1000
);

const REQUEST_TIMEOUT_MS = Number(
  process.env.REQUEST_TIMEOUT_MS || 20000
);

function getSecret() {
  return process.env.HLS_PROXY_SECRET || FALLBACK_SECRET;
}

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function sign(body) {
  return crypto
    .createHmac("sha256", getSecret())
    .update(body)
    .digest("base64url");
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
  if (!token || !token.includes(".")) {
    throw new Error("Token HLS inválido");
  }

  const [body, sig] = token.split(".", 2);
  const expected = sign(body);

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    throw new Error("Firma HLS inválida");
  }

  const payload = JSON.parse(
    Buffer.from(body, "base64url").toString("utf8")
  );

  if (
    !payload.u ||
    !payload.e ||
    Date.now() > payload.e
  ) {
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

  return (
    `${req.protocol}://${req.get("host")}` +
    `/api/hls/p/${token}`
  );
}

function rewritePlaylist(
  text,
  sourceUrl,
  req,
  referer
) {
  const lines = text.split(/\r?\n/);
  let rewrittenCount = 0;

  const rewritten = lines.map((raw) => {
    let line = raw;

    // EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA, etc.
    line = line.replace(
      /URI="([^"]+)"/g,
      (_m, uri) => {
        const target = absoluteUrl(uri, sourceUrl);

        rewrittenCount++;

        return `URI="${proxyUrlFor(
          req,
          target,
          referer
        )}"`;
      }
    );

    // URI sin comillas
    line = line.replace(
      /URI=([^",\s][^,\s]*)/g,
      (_m, uri) => {
        const target = absoluteUrl(uri, sourceUrl);

        rewrittenCount++;

        return `URI=${proxyUrlFor(
          req,
          target,
          referer
        )}`;
      }
    );

    // Playlist hijo, .ts, .m4s, etc.
    const trimmed = line.trim();

    if (
      trimmed &&
      !trimmed.startsWith("#")
    ) {
      const target = absoluteUrl(
        trimmed,
        sourceUrl
      );

      rewrittenCount++;

      return proxyUrlFor(
        req,
        target,
        referer
      );
    }

    return line;
  });

  console.log(
    `[HLS] playlist rewritten entries=${rewrittenCount}`
  );

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

      headers.Origin =
        `${ref.protocol}//${ref.host}`;
    } catch (_e) {}
  }

  if (req.headers.range) {
    headers.Range = req.headers.range;
  }

  return headers;
}

function makeRequestId() {
  return crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase();
}

async function proxySignedMedia(
  req,
  res,
  token
) {
  const requestId = makeRequestId();

  let sourceUrl = "";
  let referer = "";

  try {
    const payload = readToken(token);

    sourceUrl = payload.u;
    referer = payload.r || "";

    const requestRange =
      req.headers.range || "-";

    console.log("");
    console.log(
      `========== HLS ${requestId} ==========`
    );

    console.log(
      `[HLS ${requestId}] REQUEST`
    );

    console.log(
      `[HLS ${requestId}] url=${sourceUrl}`
    );

    console.log(
      `[HLS ${requestId}] referer=${referer || "-"}`
    );

    console.log(
      `[HLS ${requestId}] range=${requestRange}`
    );

    const upstream = await axios.get(
      sourceUrl,
      {
        responseType: "stream",
        timeout: REQUEST_TIMEOUT_MS,

        headers: upstreamHeaders(
          referer,
          req
        ),

        maxRedirects: 5,

        // Así podemos registrar 403/404/416/etc.
        validateStatus: () => true,
      }
    );

    const status =
      upstream.status || 0;

    const contentType = String(
      upstream.headers["content-type"] || ""
    );

    const contentLength = String(
      upstream.headers["content-length"] || ""
    );

    const contentRange = String(
      upstream.headers["content-range"] || ""
    );

    const acceptRanges = String(
      upstream.headers["accept-ranges"] || ""
    );

    let finalUrl = sourceUrl;

    try {
      if (
        upstream.request &&
        upstream.request.res &&
        upstream.request.res.responseUrl
      ) {
        finalUrl =
          upstream.request.res.responseUrl;
      }
    } catch (_e) {}

    console.log(
      `[HLS ${requestId}] STATUS=${status}`
    );

    console.log(
      `[HLS ${requestId}] type=${contentType || "-"}`
    );

    console.log(
      `[HLS ${requestId}] length=${contentLength || "-"}`
    );

    console.log(
      `[HLS ${requestId}] content-range=${contentRange || "-"}`
    );

    console.log(
      `[HLS ${requestId}] accept-ranges=${acceptRanges || "-"}`
    );

    if (finalUrl !== sourceUrl) {
      console.log(
        `[HLS ${requestId}] redirected=${finalUrl}`
      );
    }

    // Error del servidor/CDN
    if (
      status < 200 ||
      status >= 400
    ) {
      console.error(
        `[HLS ${requestId}] UPSTREAM ERROR status=${status}`
      );

      console.error(
        `[HLS ${requestId}] FAILED URL=${sourceUrl}`
      );

      if (
        upstream.data &&
        typeof upstream.data.destroy === "function"
      ) {
        upstream.data.destroy();
      }

      res.status(status || 502);

      res.setHeader(
        "Content-Type",
        "text/plain; charset=utf-8"
      );

      res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
      );

      res.end(
        `HLS upstream error ${status}`
      );

      console.log(
        `========== END HLS ${requestId} ==========`
      );

      return;
    }

    let pathname = "";

    try {
      pathname =
        new URL(finalUrl).pathname.toLowerCase();
    } catch (_e) {
      pathname =
        new URL(sourceUrl).pathname.toLowerCase();
    }

    const lowerContentType =
      contentType.toLowerCase();

    const isPlaylist =
      pathname.includes(".m3u8") ||
      lowerContentType.includes("mpegurl") ||
      lowerContentType.includes(
        "application/vnd.apple"
      );

    // =================================================
    // PLAYLIST M3U8
    // =================================================

    if (isPlaylist) {
      console.log(
        `[HLS ${requestId}] TYPE=PLAYLIST`
      );

      const chunks = [];
      let total = 0;

      const MAX_PLAYLIST =
        6 * 1024 * 1024;

      for await (const chunk of upstream.data) {
        total += chunk.length;

        if (total > MAX_PLAYLIST) {
          upstream.data.destroy();

          throw new Error(
            "Playlist HLS demasiado grande"
          );
        }

        chunks.push(chunk);
      }

      const text = Buffer
        .concat(chunks)
        .toString("utf8");

      console.log(
        `[HLS ${requestId}] playlist bytes=${total}`
      );

      // Solo mostramos las primeras líneas para diagnóstico
      const preview = text
        .split(/\r?\n/)
        .slice(0, 12)
        .join(" | ");

      console.log(
        `[HLS ${requestId}] playlist preview=${preview}`
      );

      const rewritten = rewritePlaylist(
        text,
        finalUrl,
        req,
        referer
      );

      res.status(status || 200);

      res.setHeader(
        "Content-Type",
        "application/vnd.apple.mpegurl"
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      res.setHeader(
        "Access-Control-Allow-Origin",
        "*"
      );

      res.setHeader(
        "Content-Length",
        Buffer.byteLength(rewritten)
      );

      res.send(rewritten);

      console.log(
        `[HLS ${requestId}] PLAYLIST SENT`
      );

      console.log(
        `========== END HLS ${requestId} ==========`
      );

      return;
    }

    // =================================================
    // SEGMENTO / KEY / MP4 / TS / M4S
    // =================================================

    console.log(
      `[HLS ${requestId}] TYPE=MEDIA`
    );

    res.status(status || 200);

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
      const value =
        upstream.headers[header];

      if (value !== undefined) {
        res.setHeader(
          header,
          value
        );
      }
    }

    res.setHeader(
      "Access-Control-Allow-Origin",
      "*"
    );

    let transferred = 0;

    upstream.data.on(
      "data",
      (chunk) => {
        transferred += chunk.length;
      }
    );

    upstream.data.on(
      "end",
      () => {
        console.log(
          `[HLS ${requestId}] MEDIA DONE bytes=${transferred}`
        );

        console.log(
          `========== END HLS ${requestId} ==========`
        );
      }
    );

    upstream.data.on(
      "error",
      (error) => {
        console.error(
          `[HLS ${requestId}] STREAM ERROR: ${error.message}`
        );

        console.error(
          `[HLS ${requestId}] URL=${sourceUrl}`
        );

        if (!res.headersSent) {
          res.status(502);
        }

        res.end();
      }
    );

    upstream.data.pipe(res);

  } catch (error) {
    console.error("");
    console.error(
      `========== HLS ERROR ${requestId} ==========`
    );

    console.error(
      `[HLS ${requestId}] message=${error.message}`
    );

    if (sourceUrl) {
      console.error(
        `[HLS ${requestId}] url=${sourceUrl}`
      );
    }

    if (referer) {
      console.error(
        `[HLS ${requestId}] referer=${referer}`
      );
    }

    if (error.response) {
      console.error(
        `[HLS ${requestId}] upstreamStatus=${error.response.status}`
      );

      console.error(
        `[HLS ${requestId}] upstreamType=${
          error.response.headers?.["content-type"] || "-"
        }`
      );
    }

    if (error.code) {
      console.error(
        `[HLS ${requestId}] code=${error.code}`
      );
    }

    console.error(
      `========== END HLS ERROR ${requestId} ==========`
    );

    if (!res.headersSent) {
      res.status(502).json({
        success: false,
        message: "Error en proxy HLS",
        error: error.message,
      });
    } else {
      res.end();
    }
  }
}

module.exports = {
  makeToken,
  proxyUrlFor,
  proxySignedMedia,
};
