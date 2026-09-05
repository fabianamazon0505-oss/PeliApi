const { axiosGet } = require("../resolver-helpers");
const { unpack, detect } = require("unpacker");
const { URL } = require("url");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// =====================================================
// URL HELPERS
// =====================================================

function absoluteUrl(value, base) {
  try {
    return new URL(value, base).href;
  } catch (_e) {
    return value;
  }
}

function looksLikeImageOrAd(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();

    const badHosts = [
      "tiktokcdn.com",
      "tiktokcdn-us.com",
      "googleusercontent.com",
      "doubleclick.net",
      "googlesyndication.com",
    ];

    if (
      badHosts.some(
        (domain) =>
          host === domain ||
          host.endsWith("." + domain)
      )
    ) {
      return true;
    }

    if (
      /\.(?:png|jpe?g|webp|gif|svg|avif)(?:$|\?)/i.test(
        path
      )
    ) {
      return true;
    }

    // StreamWish/TikTok ad resources vistos en los logs
    if (
      path.endsWith(".image") ||
      path.includes("/ad-site-")
    ) {
      return true;
    }

    return false;
  } catch (_e) {
    return false;
  }
}

// =====================================================
// PLAYLIST HELPERS
// =====================================================

function isM3u8Text(text) {
  if (typeof text !== "string") {
    return false;
  }

  return text
    .trimStart()
    .startsWith("#EXTM3U");
}

function getMediaUrls(
  playlist,
  playlistUrl
) {
  const result = [];

  const lines =
    playlist.split(/\r?\n/);

  for (const rawLine of lines) {
    const line =
      rawLine.trim();

    if (!line) continue;
    if (line.startsWith("#")) continue;

    result.push(
      absoluteUrl(
        line,
        playlistUrl
      )
    );
  }

  return result;
}

function best(
  master,
  base
) {
  try {
    const lines =
      master.split(/\r?\n/);

    let bestUrl = null;
    let bestScore = 0;

    for (
      let i = 0;
      i < lines.length;
      i++
    ) {
      const m =
        /RESOLUTION=(\d+)x(\d+)/i.exec(
          lines[i]
        );

      if (!m) continue;

      let next = null;

      // Buscar próxima línea no vacía/no comentario
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

        if (
          candidate.startsWith("#")
        ) {
          continue;
        }

        next = candidate;
        break;
      }

      if (!next) continue;

      const score =
        Number(m[1]) *
        Number(m[2]);

      if (
        score > bestScore
      ) {
        bestScore = score;

        bestUrl =
          new URL(
            next,
            base
          ).href;
      }
    }

    return bestUrl;
  } catch (_e) {
    return null;
  }
}

// =====================================================
// HTTP PLAYLIST
// =====================================================

async function fetchPlaylist(
  url,
  referer
) {
  try {
    const res =
      await axiosGet(
        url,
        {
          headers: {
            "User-Agent": UA,
            Accept:
              "application/vnd.apple.mpegurl,application/x-mpegURL,*/*",
            Referer:
              referer || url,
          },
        }
      );

    let data =
      res.data;

    if (
      Buffer.isBuffer(data)
    ) {
      data =
        data.toString(
          "utf8"
        );
    }

    if (
      typeof data !==
      "string"
    ) {
      return null;
    }

    return data;

  } catch (error) {
    console.warn(
      `[SW RESOLVER] Error obteniendo playlist ${url}: ${error.message}`
    );

    return null;
  }
}

// =====================================================
// VALIDAR MEDIA PLAYLIST
// =====================================================

async function validateMediaPlaylist(
  playlistUrl,
  referer
) {
  console.log(
    `[SW RESOLVER] Validando playlist: ${playlistUrl}`
  );

  if (
    looksLikeImageOrAd(
      playlistUrl
    )
  ) {
    console.warn(
      `[SW RESOLVER] RECHAZADO URL sospechosa: ${playlistUrl}`
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
      "[SW RESOLVER] Playlist vacío/no disponible"
    );

    return null;
  }

  if (
    !isM3u8Text(
      playlist
    )
  ) {
    console.warn(
      "[SW RESOLVER] RECHAZADO: la respuesta no comienza con #EXTM3U"
    );

    return null;
  }

  // ---------------------------------------------
  // Si sigue siendo MASTER, elegir variante
  // ---------------------------------------------

  if (
    playlist.includes(
      "#EXT-X-STREAM-INF"
    )
  ) {
    const base =
      playlistUrl.slice(
        0,
        playlistUrl.lastIndexOf(
          "/"
        ) + 1
      );

    const variant =
      best(
        playlist,
        base
      );

    if (!variant) {
      console.warn(
        "[SW RESOLVER] Master sin variante válida"
      );

      return null;
    }

    console.log(
      `[SW RESOLVER] Variante seleccionada: ${variant}`
    );

    return await validateMediaPlaylist(
      variant,
      referer
    );
  }

  // ---------------------------------------------
  // Ya debería ser un MEDIA playlist
  // ---------------------------------------------

  const mediaUrls =
    getMediaUrls(
      playlist,
      playlistUrl
    );

  if (
    mediaUrls.length === 0
  ) {
    console.warn(
      "[SW RESOLVER] RECHAZADO: playlist sin segmentos"
    );

    return null;
  }

  console.log(
    `[SW RESOLVER] Segmentos encontrados: ${mediaUrls.length}`
  );

  // Solo inspeccionamos unos pocos
  const sample =
    mediaUrls.slice(
      0,
      8
    );

  let suspicious = 0;

  for (
    const segmentUrl of
    sample
  ) {
    console.log(
      `[SW RESOLVER] segmento: ${segmentUrl}`
    );

    if (
      looksLikeImageOrAd(
        segmentUrl
      )
    ) {
      suspicious++;

      console.warn(
        `[SW RESOLVER] segmento sospechoso: ${segmentUrl}`
      );
    }
  }

  // Con uno solo ya es bastante sospechoso,
  // pero si todos son imágenes es seguro rechazar.
  if (
    suspicious ===
      sample.length &&
    sample.length > 0
  ) {
    console.warn(
      "[SW RESOLVER] RECHAZADO: los segmentos detectados son imágenes/publicidad"
    );

    return null;
  }

  // Si más de la mitad son sospechosos también rechazamos.
  if (
    suspicious >=
      Math.ceil(
        sample.length /
        2
      )
  ) {
    console.warn(
      `[SW RESOLVER] RECHAZADO: ${suspicious}/${sample.length} segmentos parecen publicidad/imágenes`
    );

    return null;
  }

  console.log(
    `[SW RESOLVER] PLAYLIST OK: ${playlistUrl}`
  );

  return playlistUrl;
}

// =====================================================
// REDIRECT STREAMWISH
// =====================================================

async function redir(
  pageUrl
) {
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

    const url =
      new URL(
        pageUrl
      );

    const destination =
      rules.includes(
        url.hostname
      )
        ? main[
            Math.floor(
              Math.random() *
                main.length
            )
          ]
        : dmca[
            Math.floor(
              Math.random() *
                dmca.length
            )
          ];

    const finalURL =
      "https://" +
      destination +
      url.pathname +
      url.search;

    return finalURL;

  } catch (error) {
    console.error(
      "[SW RESOLVER] Error al generar redirectUrl:",
      error.message
    );

    return pageUrl;
  }
}

// =====================================================
// STREAMWISH RESOLVER
// =====================================================

async function extractStreamwish(
  pageUrl
) {
  console.log(
    `[SW RESOLVER] Resolviendo: ${pageUrl}`
  );

  try {
    const finalUrl =
      await redir(
        pageUrl
      );

    console.log(
      `[SW RESOLVER] URL redirigida: ${finalUrl}`
    );

    let html;

    // =================================================
    // DESCARGAR PÁGINA
    // =================================================

    try {
      const res =
        await axiosGet(
          finalUrl,
          {
            headers: {
              "User-Agent": UA,
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              Referer:
                pageUrl,
            },
          }
        );

      html =
        res.data;

    } catch (e) {
      console.warn(
        "[SW RESOLVER] Falló URL redirigida, probando original:",
        e.message
      );

      try {
        const res =
          await axiosGet(
            pageUrl,
            {
              headers: {
                "User-Agent":
                  UA,
                Accept:
                  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                Referer:
                  pageUrl,
              },
            }
          );

        html =
          res.data;

      } catch (
        errOriginal
      ) {
        console.error(
          "[SW RESOLVER] Falló también URL original:",
          errOriginal.message
        );

        return null;
      }
    }

    if (
      Buffer.isBuffer(
        html
      )
    ) {
      html =
        html.toString(
          "utf8"
        );
    }

    if (
      typeof html !==
      "string"
    ) {
      console.error(
        "[SW RESOLVER] HTML inválido"
      );

      return null;
    }

    // =================================================
    // PACKED SCRIPT
    // =================================================

    const scriptMatch =
      html.match(
        /<script[^>]*type=['"]text\/javascript['"][^>]*>\s*(eval\(function\(p,a,c,k,e,d\)[\s\S]*?)<\/script>/i
      );

    if (!scriptMatch) {
      console.log(
        "[SW RESOLVER] Script packed no encontrado"
      );

      return null;
    }

    const packedJs =
      scriptMatch[1];

    if (
      !detect(
        packedJs
      )
    ) {
      console.log(
        "[SW RESOLVER] Script no parece Packer"
      );

      return null;
    }

    const unpacked =
      unpack(
        packedJs
      );

    const linksMatch =
      unpacked.match(
        /var\s+links\s*=\s*(\{[\s\S]*?\});/i
      );

    if (!linksMatch) {
      console.log(
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
    } catch (_e) {
      console.log(
        "[SW RESOLVER] Error parseando links"
      );

      return null;
    }

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
        rawLink
      ] of candidates
    ) {
      if (!rawLink) {
        continue;
      }

      const masterUrl =
        rawLink.startsWith(
          "/"
        )
          ? new URL(
              rawLink,
              finalUrl
            ).href
          : rawLink;

      console.log("");
      console.log(
        `[SW RESOLVER] Probando ${name}: ${masterUrl}`
      );

      if (
        looksLikeImageOrAd(
          masterUrl
        )
      ) {
        console.warn(
          `[SW RESOLVER] ${name} rechazado directamente`
        );

        continue;
      }

      const validUrl =
        await validateMediaPlaylist(
          masterUrl,
          finalUrl
        );

      if (validUrl) {
        console.log("");
        console.log(
          `[SW RESOLVER] ***** ${name} VÁLIDO *****`
        );

        console.log(
          `[SW RESOLVER] URL FINAL: ${validUrl}`
        );

        return validUrl;
      }

      console.warn(
        `[SW RESOLVER] ${name} inválido, probando siguiente...`
      );
    }

    console.error(
      "[SW RESOLVER] Ningún HLS válido encontrado"
    );

    return null;

  } catch (err) {
    console.error(
      "[SW RESOLVER] Error:",
      err.message
    );

    return null;
  }
}

module.exports = {
  extractStreamwish
};
