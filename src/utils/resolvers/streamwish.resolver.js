const { axiosGet } = require("../resolver-helpers");
const { unpack, detect } = require("unpacker");
const { URL } = require("url");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// =====================================================
// HELPERS
// =====================================================

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch (_e) {
    return value;
  }
}

function isSuspiciousUrl(url) {
  try {
    const parsed = new URL(url);

    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    // Lo vimos aparecer en los logs como imágenes/publicidad
    if (
      host === "tiktokcdn.com" ||
      host.endsWith(".tiktokcdn.com")
    ) {
      return true;
    }

    if (
      pathname.endsWith(".image") ||
      pathname.includes("/ad-site-")
    ) {
      return true;
    }

    if (
      /\.(png|jpg|jpeg|webp|gif|svg|avif)$/i.test(pathname)
    ) {
      return true;
    }

    return false;
  } catch (_e) {
    return false;
  }
}

function isM3u8(text) {
  if (typeof text !== "string") {
    return false;
  }

  return text.trimStart().startsWith("#EXTM3U");
}

function getPlaylistUrls(playlist, playlistUrl) {
  const urls = [];

  const lines = playlist.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) continue;
    if (line.startsWith("#")) continue;

    urls.push(
      absoluteUrl(line, playlistUrl)
    );
  }

  return urls;
}

// =====================================================
// BUSCAR MEJOR CALIDAD EN MASTER
// =====================================================

function getBestVariant(master, masterUrl) {
  try {
    const lines = master.split(/\r?\n/);

    let bestUrl = null;
    let bestScore = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      if (!line.includes("#EXT-X-STREAM-INF")) {
        continue;
      }

      const resMatch =
        /RESOLUTION=(\d+)x(\d+)/i.exec(line);

      let score = 0;

      if (resMatch) {
        score =
          Number(resMatch[1]) *
          Number(resMatch[2]);
      }

      let variant = null;

      for (
        let j = i + 1;
        j < lines.length;
        j++
      ) {
        const candidate =
          lines[j].trim();

        if (!candidate) {
          continue;
        }

        if (candidate.startsWith("#")) {
          continue;
        }

        variant = absoluteUrl(
          candidate,
          masterUrl
        );

        break;
      }

      if (!variant) {
        continue;
      }

      if (
        bestUrl === null ||
        score > bestScore
      ) {
        bestUrl = variant;
        bestScore = score;
      }
    }

    return bestUrl;
  } catch (_e) {
    return null;
  }
}

// =====================================================
// DESCARGAR PLAYLIST
// =====================================================

async function fetchPlaylist(url, referer) {
  try {
    const response = await axiosGet(url, {
      headers: {
        "User-Agent": UA,
        Accept:
          "application/vnd.apple.mpegurl, application/x-mpegURL, */*",
        Referer: referer || url,
      },
    });

    let data = response.data;

    if (Buffer.isBuffer(data)) {
      data = data.toString("utf8");
    }

    if (typeof data !== "string") {
      return null;
    }

    return data;
  } catch (error) {
    console.warn(
      `[SW RESOLVER] Error descargando playlist: ${error.message}`
    );

    return null;
  }
}

// =====================================================
// VALIDAR PLAYLIST REAL
// =====================================================

async function validatePlaylist(
  playlistUrl,
  referer,
  depth = 0
) {
  if (depth > 3) {
    console.warn(
      "[SW RESOLVER] Demasiados niveles de playlist"
    );

    return null;
  }

  console.log(
    `[SW RESOLVER] Validando: ${playlistUrl}`
  );

  if (isSuspiciousUrl(playlistUrl)) {
    console.warn(
      `[SW RESOLVER] URL sospechosa rechazada: ${playlistUrl}`
    );

    return null;
  }

  const playlist =
    await fetchPlaylist(
      playlistUrl,
      referer
    );

  if (!playlist) {
    console.warn(
      "[SW RESOLVER] Playlist no disponible"
    );

    return null;
  }

  if (!isM3u8(playlist)) {
    console.warn(
      "[SW RESOLVER] Respuesta rechazada: no comienza con #EXTM3U"
    );

    return null;
  }

  // ---------------------------------------------------
  // MASTER PLAYLIST
  // ---------------------------------------------------

  if (
    playlist.includes(
      "#EXT-X-STREAM-INF"
    )
  ) {
    console.log(
      "[SW RESOLVER] Detectado MASTER playlist"
    );

    const variant =
      getBestVariant(
        playlist,
        playlistUrl
      );

    if (!variant) {
      console.warn(
        "[SW RESOLVER] No se encontró variante válida"
      );

      return null;
    }

    console.log(
      `[SW RESOLVER] Mejor variante: ${variant}`
    );

    return validatePlaylist(
      variant,
      referer,
      depth + 1
    );
  }

  // ---------------------------------------------------
  // MEDIA PLAYLIST
  // ---------------------------------------------------

  const urls =
    getPlaylistUrls(
      playlist,
      playlistUrl
    );

  if (urls.length === 0) {
    console.warn(
      "[SW RESOLVER] Playlist sin segmentos"
    );

    return null;
  }

  console.log(
    `[SW RESOLVER] Segmentos detectados: ${urls.length}`
  );

  const sample =
    urls.slice(0, 10);

  let suspiciousCount = 0;

  for (const mediaUrl of sample) {
    console.log(
      `[SW RESOLVER] Segmento: ${mediaUrl}`
    );

    if (
      isSuspiciousUrl(
        mediaUrl
      )
    ) {
      suspiciousCount++;

      console.warn(
        `[SW RESOLVER] Segmento sospechoso: ${mediaUrl}`
      );
    }
  }

  if (
    suspiciousCount > 0
  ) {
    console.warn(
      `[SW RESOLVER] RECHAZADO: ${suspiciousCount}/${sample.length} segmentos sospechosos`
    );

    return null;
  }

  console.log(
    `[SW RESOLVER] PLAYLIST VÁLIDO: ${playlistUrl}`
  );

  return playlistUrl;
}

// =====================================================
// GENERAR DOMINIO ALTERNATIVO STREAMWISH
// =====================================================

async function redir(pageUrl) {
  try {
    const dmca = [
      "playnixes.com",
      "niramirus.com",
      "medixiru.com",
      "hgplaycdn.com",
      "hglamioz.com",
    ];

    const main = [
      "kravaxxa.com",
      "davioad.com",
      "haxloppd.com",
      "tryzendm.com",
      "dumbalag.com",
    ];

    const rules = [
      "dhcplay.com",
      "hglink.to",
      "test.hglink.to",
      "wish-redirect.aiavh.com",
    ];

    const parsed =
      new URL(pageUrl);

    const hostname =
      parsed.hostname
        .replace(/^www\./, "")
        .toLowerCase();

    const pool =
      rules.includes(hostname)
        ? main
        : dmca;

    const destination =
      pool[
        Math.floor(
          Math.random() *
          pool.length
        )
      ];

    return (
      "https://" +
      destination +
      parsed.pathname +
      parsed.search
    );
  } catch (error) {
    console.error(
      "[SW RESOLVER] Error generando redirect:",
      error.message
    );

    return pageUrl;
  }
}

// =====================================================
// DESCARGAR HTML STREAMWISH
// =====================================================

async function fetchStreamwishHtml(
  url,
  referer
) {
  const response =
    await axiosGet(url, {
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        Referer:
          referer || url,
      },
    });

  let html =
    response.data;

  if (Buffer.isBuffer(html)) {
    html =
      html.toString(
        "utf8"
      );
  }

  return html;
}

// =====================================================
// EXTRACT STREAMWISH
// =====================================================

async function extractStreamwish(pageUrl) {
  console.log("");
  console.log(
    "======================================"
  );

  console.log(
    `[SW RESOLVER] Resolviendo: ${pageUrl}`
  );

  try {
    const finalUrl =
      await redir(pageUrl);

    console.log(
      `[SW RESOLVER] URL alternativa: ${finalUrl}`
    );

    let html = null;

    // Primero probar dominio alternativo
    try {
      html =
        await fetchStreamwishHtml(
          finalUrl,
          pageUrl
        );
    } catch (error) {
      console.warn(
        `[SW RESOLVER] Falló dominio alternativo: ${error.message}`
      );
    }

    // Si falla, probar original
    if (!html) {
      try {
        console.log(
          "[SW RESOLVER] Probando URL original..."
        );

        html =
          await fetchStreamwishHtml(
            pageUrl,
            pageUrl
          );
      } catch (error) {
        console.error(
          `[SW RESOLVER] Falló URL original: ${error.message}`
        );

        return null;
      }
    }

    if (
      typeof html !== "string"
    ) {
      console.error(
        "[SW RESOLVER] HTML inválido"
      );

      return null;
    }

    // =================================================
    // EXTRAER SCRIPT PACKED
    // =================================================

    const scriptMatch =
      html.match(
        /<script[^>]*type=['"]text\/javascript['"][^>]*>\s*(eval\(function\(p,a,c,k,e,d\)[\s\S]*?)<\/script>/i
      );

    if (!scriptMatch) {
      console.warn(
        "[SW RESOLVER] Script packed no encontrado"
      );

      return null;
    }

    const packedJs =
      scriptMatch[1];

    if (!detect(packedJs)) {
      console.warn(
        "[SW RESOLVER] Script no reconocido por unpacker"
      );

      return null;
    }

    const unpacked =
      unpack(packedJs);

    // =================================================
    // EXTRAER OBJETO links
    // =================================================

    const linksMatch =
      unpacked.match(
        /var\s+links\s*=\s*(\{[\s\S]*?\});/i
      );

    if (!linksMatch) {
      console.warn(
        "[SW RESOLVER] Objeto links no encontrado"
      );

      return null;
    }

    let links;

    try {
      links =
        JSON.parse(
          linksMatch[1]
        );
    } catch (error) {
      console.error(
        `[SW RESOLVER] Error parseando links: ${error.message}`
      );

      return null;
    }

    console.log(
      `[SW RESOLVER] links encontrados: ${Object.keys(
        links
      ).join(", ")}`
    );

    // =================================================
    // PROBAR TODOS LOS HLS
    // =================================================

    const candidates = [
      ["hls4", links.hls4],
      ["hls3", links.hls3],
      ["hls1", links.hls1],
      ["hls2", links.hls2],
    ];

    for (
      const [
        name,
        rawUrl
      ] of candidates
    ) {
      if (!rawUrl) {
        console.log(
          `[SW RESOLVER] ${name}: no existe`
        );

        continue;
      }

      let candidateUrl;

      try {
        candidateUrl =
          absoluteUrl(
            rawUrl,
            finalUrl
          );
      } catch (_e) {
        candidateUrl =
          rawUrl;
      }

      console.log("");
      console.log(
        `[SW RESOLVER] Probando ${name}`
      );

      console.log(
        `[SW RESOLVER] URL: ${candidateUrl}`
      );

      const valid =
        await validatePlaylist(
          candidateUrl,
          finalUrl
        );

      if (valid) {
        console.log("");
        console.log(
          `========== ${name} VÁLIDO ==========`
        );

        console.log(
          `[SW RESOLVER] URL FINAL: ${valid}`
        );

        console.log(
          "======================================"
        );

        return valid;
      }

      console.warn(
        `[SW RESOLVER] ${name} RECHAZADO`
      );
    }

    console.error("");
    console.error(
      "[SW RESOLVER] NINGÚN HLS VÁLIDO"
    );

    console.log(
      "======================================"
    );

    return null;

  } catch (error) {
    console.error(
      `[SW RESOLVER] ERROR GENERAL: ${error.message}`
    );

    return null;
  }
}

module.exports = {
  extractStreamwish,
};
