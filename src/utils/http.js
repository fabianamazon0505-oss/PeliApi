const axios = require("axios");
const { URL } = require("node:url");
const { ApiError } = require("./api-error");

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "*/*",
};

const HTML_HEADERS = {
  "User-Agent": DEFAULT_HEADERS["User-Agent"],
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

async function fetchHtml(url, customHeaders = {}) {
  try {
    const timeout = Number(
      process.env.REQUEST_TIMEOUT_MS || 15000
    );

    console.log(`[HTTP] GET ${url}`);

    const response = await axios.get(url, {
      timeout,
      headers: {
        ...HTML_HEADERS,
        ...customHeaders,
        Referer: "https://pelisplushd.to/",
      },
      maxRedirects: 5,
      validateStatus: (status) =>
        status >= 200 && status < 400,
    });

    console.log(
      `[HTTP] OK ${response.status} ${url} | bytes=${String(
        response.data
      ).length}`
    );

    return response.data;
  } catch (error) {
    console.error(`[HTTP] ERROR ${url}`);
    console.error(
      `[HTTP] message: ${error.message}`
    );

    if (error.response) {
      console.error(
        `[HTTP] status: ${error.response.status}`
      );

      console.error(
        `[HTTP] headers: ${JSON.stringify(
          error.response.headers
        )}`
      );

      let body = "";

      try {
        body =
          typeof error.response.data === "string"
            ? error.response.data.substring(0, 500)
            : JSON.stringify(
                error.response.data
              ).substring(0, 500);
      } catch (_e) {
        body = "No se pudo leer el body";
      }

      console.error(`[HTTP] body: ${body}`);
    } else {
      console.error(
        "[HTTP] Sin respuesta HTTP del servidor"
      );

      if (error.code) {
        console.error(
          `[HTTP] code: ${error.code}`
        );
      }
    }

    throw new ApiError(
      500,
      `No se pudo obtener el contenido desde ${url}`,
      error.message
    );
  }
}

async function fetchHtmlWithHeaders(
  url,
  referer,
  customHeaders = {}
) {
  try {
    const timeout = Number(
      process.env.REQUEST_TIMEOUT_MS || 15000
    );

    const headers = {
      ...HTML_HEADERS,
      ...customHeaders,
    };

    if (referer) {
      headers.Referer = referer;
    }

    const response = await axios.get(url, {
      timeout,
      headers,
      maxRedirects: 5,
      validateStatus: (status) =>
        status >= 200 && status < 400,
    });

    return {
      html: response.data,
      headers: response.headers,
    };
  } catch (error) {
    console.error(
      `[HTTP] ERROR ${url}: ${error.message}`
    );

    if (error.response) {
      console.error(
        `[HTTP] status: ${error.response.status}`
      );
    }

    throw new ApiError(
      500,
      `Error de red al consultar ${url}`,
      error.message
    );
  }
}

function resolveAbsoluteUrl(base, relative) {
  if (!relative) return "";

  try {
    return new URL(relative, base).href;
  } catch (_e) {
    return relative;
  }
}

function normalizeExtractedUrl(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  return value
    .replace(/\\u0026/g, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/g, "&")
    .replace(/%3A/gi, ":")
    .replace(/%2F/gi, "/")
    .replace(/%3F/gi, "?")
    .replace(/%3D/gi, "=")
    .trim();
}

function decodeIfEncoded(url) {
  if (!url || typeof url !== "string") {
    return url;
  }

  try {
    if (
      url.includes("%") &&
      url.match(/%[0-9A-Fa-f]{2}/)
    ) {
      return decodeURIComponent(url);
    }
  } catch (_e) {
    // Ignorar errores de decode
  }

  return url;
}

function isLikelyVideoUrl(url) {
  if (!url || typeof url !== "string") {
    return false;
  }

  const lower = url.toLowerCase();

  const excludePatterns = [
    "cloudflareinsights",
    "google-analytics",
    "googletagmanager",
    "facebook.net",
    "beacon.min.js",
    ".js?",
    "analytics",
    "pixel",
    "bigbuckbunny",
    "test-videos",
    "sample-video",
    "placeholder",
  ];

  for (const pattern of excludePatterns) {
    if (lower.includes(pattern)) {
      return false;
    }
  }

  return (
    /\.(mp4|m3u8)$/i.test(url) ||
    lower.includes("video") ||
    lower.includes("stream") ||
    lower.includes(".mp4") ||
    lower.includes(".m3u8")
  );
}

function findFirstUrl(payload, patterns) {
  if (!payload || typeof payload !== "string") {
    return null;
  }

  for (const pattern of patterns) {
    try {
      const match = payload.match(pattern);

      if (match && match[1]) {
        const candidate =
          normalizeExtractedUrl(match[1]);

        if (
          candidate &&
          isLikelyVideoUrl(candidate)
        ) {
          return decodeIfEncoded(candidate);
        }
      }
    } catch (_e) {
      // Ignorar patrones inválidos
    }
  }

  const urlMatch = payload.match(
    /(https?:\/\/[^\s"'<>]+\.(?:m3u8|mp4)[^\s"'<>]*)/i
  );

  if (urlMatch && urlMatch[1]) {
    const candidate =
      normalizeExtractedUrl(urlMatch[1]);

    if (isLikelyVideoUrl(candidate)) {
      return decodeIfEncoded(candidate);
    }
  }

  return null;
}

module.exports = {
  DEFAULT_HEADERS,
  HTML_HEADERS,
  fetchHtml,
  fetchHtmlWithHeaders,
  resolveAbsoluteUrl,
  normalizeExtractedUrl,
  decodeIfEncoded,
  isLikelyVideoUrl,
  findFirstUrl,
};
