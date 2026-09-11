const cheerio = require("cheerio");
const { fetchHtml } = require("../utils/http");
const { ApiError } = require("../utils/api-error");
const axios = require("axios");

const BASE_URL =
  process.env.REPELISHD_DOMAIN ||
  "https://repelishd.courses";

/**
 * Normaliza las URLs para que siempre sean absolutas
 */
function getAbsoluteUrl(path) {
  if (!path) return "";

  if (
    path.startsWith("http://") ||
    path.startsWith("https://")
  ) {
    return path;
  }

  return `${BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

/**
 * Extrae slug desde una URL de RePelisHD
 */
function extractSlug(href) {
  if (!href) return "";

  let slug = href;

  if (slug.includes("/ver-pelicula/")) {
    slug = slug.split("/ver-pelicula/").pop();
  } else {
    slug = slug.split("/").filter(Boolean).pop() || "";
  }

  return slug
    .replace(".html", "")
    .replace(/\?.*$/, "")
    .replace(/\/+$/, "")
    .trim();
}

/**
 * Obtiene catálogo de películas desde RePelisHD
 *
 * Página 1:
 * https://repelishd.courses/cine/
 *
 * Páginas siguientes:
 * https://repelishd.courses/cine/page/2/
 */
async function getCatalog(
  type = "movie",
  genre = "",
  page = 1
) {
  // Por ahora este proveedor se usa como fallback
  // principalmente para películas.
  if (type !== "movie") {
    return {
      items: [],
      page: Number(page),
      hasNextPage: false,
    };
  }

  let url;

  if (genre) {
    /*
     * RePelisHD usa categorías/rutas tipo:
     * /accion/
     * /comedia/
     * /documental/
     *
     * Si se recibe genre usamos directamente esa ruta.
     */
    if (Number(page) > 1) {
      url =
        `${BASE_URL}/${genre}/page/${Number(page)}/`;
    } else {
      url =
        `${BASE_URL}/${genre}/`;
    }
  } else {
    if (Number(page) > 1) {
      url =
        `${BASE_URL}/cine/page/${Number(page)}/`;
    } else {
      url =
        `${BASE_URL}/cine/`;
    }
  }

  console.log(`[REPELISHD] Catalog URL: ${url}`);

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const items = [];
  const seen = new Set();

  /*
   * Intentamos varios selectores porque el sitio
   * puede cambiar pequeñas partes del layout.
   */
  const selectors = [
    "#dle-content article.item",
    "article.item",
    ".items article",
    ".items .item",
    ".movies-list article",
    ".movies-list .item",
    ".moviefilm",
    ".poster"
  ];

  const processCard = (element) => {
    const el = $(element);

    let linkElement =
      el.find('a[href*="/ver-pelicula/"]').first();

    if (!linkElement.length) {
      linkElement = el.find("a").first();
    }

    let href =
      linkElement.attr("href") ||
      el.attr("href") ||
      "";

    if (!href) {
      return;
    }

    // Evitamos enlaces de navegación que no sean contenido
    if (
      !href.includes("/ver-pelicula/") &&
      !href.includes(".html")
    ) {
      return;
    }

    href = getAbsoluteUrl(href);

    const slug = extractSlug(href);

    if (!slug || seen.has(slug)) {
      return;
    }

    const img = el.find("img").first();

    const posterRaw =
      img.attr("data-src") ||
      img.attr("data-lazy-src") ||
      img.attr("src") ||
      "";

    const poster =
      getAbsoluteUrl(posterRaw);

    let title =
      el.find(".data h3 a").first().text().trim() ||
      el.find("h3 a").first().text().trim() ||
      el.find("h2 a").first().text().trim() ||
      el.find(".title").first().text().trim() ||
      linkElement.attr("title") ||
      img.attr("alt") ||
      "";

    // Limpiar espacios repetidos
    title = title
      .replace(/\s+/g, " ")
      .trim();

    if (!title) {
      return;
    }

    const text =
      el.text().replace(/\s+/g, " ").trim();

    const yearMatch =
      text.match(/\b(?:19|20)\d{2}\b/);

    const year =
      yearMatch
        ? yearMatch[0]
        : null;

    let rating =
      el.find(".rating").first().text().trim() ||
      el.find(".starstruck-rating").first().text().trim() ||
      el.find(".vote").first().text().trim() ||
      null;

    if (rating) {
      rating = rating.trim();
    }

    seen.add(slug);

    items.push({
      id: slug,
      slug,
      title,
      poster,
      rating,
      year,
      type: "movie",
      url: href,
    });
  };

  /*
   * Primero probamos los selectores específicos.
   */
  for (const selector of selectors) {
    $(selector).each((_, element) => {
      processCard(element);
    });
  }

  /*
   * Fallback:
   * buscar directamente cualquier enlace a /ver-pelicula/
   */
  if (items.length === 0) {
    $('a[href*="/ver-pelicula/"]').each(
      (_, anchor) => {
        const a = $(anchor);

        const parent =
          a.closest(
            "article, .item, .poster, li, .movie"
          );

        if (parent.length) {
          processCard(parent);
        } else {
          processCard(a);
        }
      }
    );
  }

  /*
   * Detectar si existe una página siguiente.
   */
  let hasNextPage = false;

  const nextSelectors = [
    '.pagination a[rel="next"]',
    ".pagination .next a",
    ".pagination a.next",
    ".navigation a.next",
    'a[href*="/page/"]'
  ];

  for (const selector of nextSelectors) {
    if ($(selector).length > 0) {
      hasNextPage = true;
      break;
    }
  }

  console.log(
    `[REPELISHD] Catalog encontrados: ${items.length}`
  );

  return {
    items,
    page: Number(page),
    hasNextPage,
  };
}

/**
 * Busca películas en RePelisHD usando la consulta POST de DLE
 */
async function searchContent(query) {
  if (!query) {
    throw new ApiError(
      400,
      "El parametro de busqueda 's' o 'q' es requerido"
    );
  }

  const url =
    `${BASE_URL}/index.php?do=search`;

  const postData =
    `do=search&subaction=search&story=${encodeURIComponent(
      query
    )}`;

  try {
    const response = await axios.post(
      url,
      postData,
      {
        timeout: 15000,

        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",

          "Content-Type":
            "application/x-www-form-urlencoded",

          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

          Referer:
            `${BASE_URL}/`,
        },
      }
    );

    const $ =
      cheerio.load(response.data);

    const results = [];

    $("#dle-content article.item").each(
      (_, element) => {
        const el =
          $(element);

        const posterDiv =
          el.find(".poster");

        const posterLink =
          posterDiv.find("a");

        const href =
          posterLink.attr("href") ||
          "";

        const img =
          posterDiv.find("img");

        const poster =
          getAbsoluteUrl(
            img.attr("src") ||
            img.attr("data-src") ||
            ""
          );

        const titleLink =
          el.find(".data h3 a");

        const title =
          titleLink
            .text()
            .trim();

        const ratingText =
          posterDiv
            .find(".rating")
            .text()
            .trim();

        const rating =
          ratingText
            ? ratingText
            : null;

        const yearText =
          el
            .find(".data span, .poster span")
            .text()
            .trim();

        const year =
          yearText
            ? yearText
                .replace("HD", "")
                .trim()
            : null;

        const slug =
          extractSlug(href);

        if (slug) {
          results.push({
            id: slug,
            slug,
            title,
            poster,
            rating,
            year,
            type: "movie",
            url: getAbsoluteUrl(href),
          });
        }
      }
    );

    const uniqueResults = [];
    const seen = new Set();

    for (const r of results) {
      if (!seen.has(r.slug)) {
        seen.add(r.slug);
        uniqueResults.push(r);
      }
    }

    return uniqueResults;

  } catch (error) {
    console.error(
      "Error in RePelisHD searchContent:",
      error.message
    );

    return [];
  }
}

/**
 * Obtiene la información detallada y los servidores
 * de una película en RePelisHD
 */
async function getContentInfo(
  slug,
  type = "movie"
) {
  if (!slug) {
    throw new ApiError(
      400,
      "El slug del contenido es requerido"
    );
  }

  const path =
    `/ver-pelicula/${slug}.html`;

  const url =
    `${BASE_URL}${path}`;

  const html =
    await fetchHtml(url);

  const $ =
    cheerio.load(html);

  const title =
    $("h1")
      .not(".text")
      .text()
      .replace(" online HD", "")
      .replace(" online", "")
      .trim() ||

    $(".title")
      .first()
      .text()
      .trim() ||

    "";

  if (!title) {
    throw new ApiError(
      404,
      "Contenido no encontrado en RePelisHD"
    );
  }

  const synopsis =
    $(".description p")
      .text()
      .trim() ||

    $(".description")
      .text()
      .trim() ||

    "";

  const poster =
    getAbsoluteUrl(
      $(".poster img")
        .first()
        .attr("src") ||

      $(".poster img")
        .first()
        .attr("data-src") ||

      ""
    );

  let year = null;

  const yearMatch =
    $(".meta, .info, body")
      .text()
      .match(/\d{4}/);

  if (yearMatch) {
    year =
      yearMatch[0];
  }

  let rating =
    $(".starstruck-rating, .dt_rating_vgs")
      .first()
      .text()
      .trim() ||
    null;

  const genres = [];

  $('a[href*="/genero/"]').each(
    (_, el) => {
      const text =
        $(el)
          .text()
          .trim();

      const href =
        $(el)
          .attr("href") ||
        "";

      const gSlug =
        href
          .split("/genero/")
          .pop()
          .replace(/\//g, "");

      if (
        text &&
        !genres.some(
          g => g.slug === gSlug
        )
      ) {
        genres.push({
          name: text,
          slug: gSlug,
        });
      }
    }
  );

  const contentInfo = {
    id: slug,
    slug,
    title,
    originalTitle: title,
    synopsis,
    poster,
    rating,
    year,
    genres,
    cast: [],
    directors: [],
    type: "movie",
    url,
  };

  const servers = [];

  /*
   * Buscar iframe del resolver
   */
  const iframeSrc =
    $("iframe")
      .first()
      .attr("src") ||

    $("iframe")
      .first()
      .attr("data-src") ||

    "";

  if (
    iframeSrc &&
    iframeSrc.includes("verhdlink.cam")
  ) {
    try {
      const resolverHtml =
        await fetchHtml(
          iframeSrc,
          {
            Referer: url,
          }
        );

      const r$ =
        cheerio.load(
          resolverHtml
        );

      const languages = [
        {
          key: "latino",
          label: "Latino"
        },
        {
          key: "castellano",
          label: "Castellano"
        },
        {
          key: "subtitulado",
          label: "Subtitulado"
        }
      ];

      for (const lang of languages) {
        r$(`ul.${lang.key} li`).each(
          (_, el) => {
            const mirror =
              r$(el);

            const dataLink =
              mirror.attr("data-link") ||
              "";

            let text =
              mirror
                .text()
                .trim()
                .toLowerCase();

            if (dataLink) {
              let embedUrl =
                dataLink;

              if (
                embedUrl.startsWith("//")
              ) {
                embedUrl =
                  `https:${embedUrl}`;
              }

              let serverKey =
                "unknown";

              let serverName =
                "Directo";

              if (
                text.includes("dropload") ||
                embedUrl.includes("dr0pstream") ||
                embedUrl.includes("dropload")
              ) {
                serverKey =
                  "dropload";

                serverName =
                  "Dropload";

              } else if (
                text.includes("mixdrop") ||
                embedUrl.includes("mixdrop")
              ) {
                serverKey =
                  "mixdrop";

                serverName =
                  "Mixdrop";

              } else if (
                text.includes("doodstream") ||
                text.includes("dood") ||
                embedUrl.includes("dood")
              ) {
                serverKey =
                  "doodstream";

                serverName =
                  "Doodstream";

              } else if (
                text.includes("streamwish") ||
                embedUrl.includes("streamwish")
              ) {
                serverKey =
                  "streamwish";

                serverName =
                  "Streamwish";

              } else if (
                text.includes("fullhd") ||
                text.includes("4k") ||
                text.includes("server 4k")
              ) {
                serverKey =
                  "server4k";

                serverName =
                  "Server 4K";
              }

              servers.push({
                name:
                  serverName,

                server:
                  serverKey,

                language:
                  lang.label,

                embedUrl,
              });
            }
          }
        );
      }

    } catch (err) {
      console.error(
        "Error fetching player mirrors from verhdlink resolver:",
        err.message
      );
    }
  }

  contentInfo.servers =
    servers;

  return contentInfo;
}

/**
 * Placeholder para compatibilidad con series
 */
async function getEpisodeServers(
  serieSlug,
  seasonNumber,
  episodeNumber
) {
  return {
    serieSlug,

    season:
      Number(
        seasonNumber
      ),

    episode:
      Number(
        episodeNumber
      ),

    servers: [],

    url: "",
  };
}

module.exports = {
  getCatalog,
  searchContent,
  getContentInfo,
  getEpisodeServers,
};
