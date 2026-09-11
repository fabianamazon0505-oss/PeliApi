const express = require("express");
const { dailyRateLimit } = require("../middlewares/rate-limit");
const pelisplusService = require("../services/pelisplus.service");
const cuevanaService = require("../services/cuevana.service");
const repelishdService = require("../services/repelishd.service");
const downloadService = require("../services/download.service");
const { resolveEmbedUrl } = require("../utils/resolvers");
const { ApiError } = require("../utils/api-error");

const router = express.Router();

function asyncHandler(handler) {
  return async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
}

// Límites de tráfico
router.use(dailyRateLimit);

/**
 * Buscar contenido
 * GET /search?s=avatar
 */
router.get(
  "/search",
  asyncHandler(async (req, res) => {
    const query = req.query.s || req.query.q || "";

    if (!query) {
      throw new ApiError(
        400,
        "El parametro de busqueda 's' o 'q' es requerido"
      );
    }

    let data = [];
    let source = "aggregate";

    try {
      const [ppData, rpData] = await Promise.all([
        pelisplusService.searchContent(query).catch((err) => {
          console.error("Error buscando en PelisPlus:", err.message);
          return [];
        }),

        repelishdService.searchContent(query).catch((err) => {
          console.error("Error buscando en RePelisHD:", err.message);
          return [];
        }),
      ]);

      const ppMapped = (ppData || []).map((item) => ({
        ...item,
        provider: "pelisplus",
      }));

      const rpMapped = (rpData || []).map((item) => ({
        ...item,
        provider: "repelishd",
      }));

      data = [...rpMapped, ...ppMapped];

      const lowerQuery = query.toLowerCase().trim();

      data.sort((a, b) => {
        const aTitle = (a.title || "").toLowerCase();
        const bTitle = (b.title || "").toLowerCase();

        const aExact =
          aTitle === lowerQuery ||
          aTitle === `[${lowerQuery}]`;

        const bExact =
          bTitle === lowerQuery ||
          bTitle === `[${lowerQuery}]`;

        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;

        const aStarts =
          aTitle.startsWith(lowerQuery) ||
          aTitle.startsWith(`[${lowerQuery}`);

        const bStarts =
          bTitle.startsWith(lowerQuery) ||
          bTitle.startsWith(`[${lowerQuery}`);

        if (aStarts && !bStarts) return -1;
        if (!aStarts && bStarts) return 1;

        const aIncludes =
          aTitle.includes(lowerQuery);

        const bIncludes =
          bTitle.includes(lowerQuery);

        if (aIncludes && !bIncludes) return -1;
        if (!aIncludes && bIncludes) return 1;

        return 0;
      });

      if (data.length > 0) {
        source =
          rpMapped.length > 0
            ? "repelishd"
            : "pelisplus";
      }
    } catch (error) {
      console.error(
        "Error en búsqueda paralela:",
        error.message
      );
    }

    if (data.length === 0) {
      try {
        const cuevanaData =
          await cuevanaService.searchContent(query);

        data = (cuevanaData || []).map((item) => ({
          ...item,
          provider: "cuevana3",
        }));

        source = "cuevana3";
      } catch (error) {
        console.error(
          "Error buscando en Cuevana3:",
          error.message
        );
      }
    }

    res.status(200).json({
      success: true,
      data,
      source,
    });
  })
);

/**
 * Catálogo
 * GET /catalog?type=movie&genre=accion&page=1
 */
router.get(
  "/catalog",
  asyncHandler(async (req, res) => {
    const type =
      req.query.type || "movie";

    const genre =
      req.query.genre || "";

    const page =
      Number(req.query.page || 1);

    let data;
    let source = "pelisplus";

    try {
      console.log(
        `[CATALOG] Intentando PelisPlus: type=${type} page=${page}`
      );

      data =
        await pelisplusService.getCatalog(
          type,
          genre,
          page
        );

      if (data && data.items) {
        data.items =
          data.items.map((item) => ({
            ...item,
            provider: "pelisplus",
          }));
      }

      console.log(
        `[CATALOG] PelisPlus OK: ${
          data?.items?.length || 0
        } items`
      );

    } catch (error) {
      console.error(
        `[CATALOG] PelisPlus falló: ${error.message}`
      );

      if (type === "movie") {
        console.log(
          "[CATALOG] Usando RePelisHD como fallback"
        );

        data =
          await repelishdService.getCatalog(
            type,
            genre,
            page
          );

        source = "repelishd";

        if (data && data.items) {
          data.items =
            data.items.map((item) => ({
              ...item,
              provider: "repelishd",
            }));
        }

        console.log(
          `[CATALOG] RePelisHD OK: ${
            data?.items?.length || 0
          } items`
        );

      } else {
        throw error;
      }
    }

    res.status(200).json({
      success: true,
      data,
      source,
    });
  })
);

/**
 * Géneros
 */
router.get(
  "/genres",
  asyncHandler(async (req, res) => {
    let data;
    let source = "pelisplus";

    try {
      data =
        await pelisplusService.getGenres();
    } catch (error) {
      console.error(
        `[GENRES] PelisPlus falló: ${error.message}`
      );

      // Lista básica fallback
      data = [
        { name: "Acción", slug: "accion" },
        { name: "Animación", slug: "animacion" },
        { name: "Aventura", slug: "aventura" },
        { name: "Bélica", slug: "belica" },
        { name: "Biografía", slug: "biografia" },
        { name: "Ciencia ficción", slug: "ciencia-ficcion" },
        { name: "Comedia", slug: "comedia" },
        { name: "Crimen", slug: "crimen" },
        { name: "Documental", slug: "documental" },
        { name: "Drama", slug: "drama" },
        { name: "Familia", slug: "familia" },
        { name: "Fantasía", slug: "fantasia" },
        { name: "Romance", slug: "romance" },
        { name: "Suspenso", slug: "suspenso" },
        { name: "Terror", slug: "terror" },
      ];

      source = "repelishd";
    }

    res.status(200).json({
      success: true,
      data,
      source,
    });
  })
);

/**
 * Info de contenido
 */
router.get(
  "/info/*",
  asyncHandler(async (req, res) => {
    const slug =
      req.params[0];

    const type =
      req.query.type || "movie";

    let provider =
      req.query.provider;

    if (!provider) {
      if (
        slug.includes("/") &&
        !slug.startsWith("pelicula/") &&
        !slug.startsWith("serie/") &&
        !slug.startsWith("anime/")
      ) {
        provider = "cuevana3";

      } else if (
        slug.includes("-online-espanol")
      ) {
        provider = "repelishd";

      } else {
        provider = "pelisplus";
      }
    }

    let data;
    let source = provider;

    try {
      let service;

      if (provider === "cuevana3") {
        service = cuevanaService;

      } else if (
        provider === "repelishd"
      ) {
        service = repelishdService;

      } else {
        service = pelisplusService;
      }

      data =
        await service.getContentInfo(
          slug,
          type
        );

    } catch (error) {
      if (provider === "pelisplus") {
        try {
          console.log(
            `Cascading info request to RePelisHD for slug: ${slug}`
          );

          data =
            await repelishdService.getContentInfo(
              slug,
              type
            );

          source = "repelishd";

        } catch (repelisError) {
          try {
            console.log(
              `Cascading info request to Cuevana3 for slug: ${slug}`
            );

            data =
              await cuevanaService.getContentInfo(
                slug,
                type
              );

            source = "cuevana3";

          } catch (cascadeError) {
            console.error(
              "Cuevana3 cascade failed too:",
              cascadeError.message
            );

            throw error;
          }
        }

      } else {
        throw error;
      }
    }

    if (data) {
      data.provider = source;
    }

    res.status(200).json({
      success: true,
      data,
      source,
    });
  })
);

/**
 * Servidores de episodios
 */
router.get(
  "/servers",
  asyncHandler(async (req, res) => {
    const slug =
      req.query.slug ||
      req.query.serieSlug;

    const season =
      Number(req.query.season || 1);

    const episode =
      Number(req.query.episode || 1);

    let provider =
      req.query.provider;

    if (!slug) {
      throw new ApiError(
        400,
        "El parametro 'slug' de la serie es requerido"
      );
    }

    if (!provider) {
      if (slug.includes("/")) {
        provider = "cuevana3";

      } else if (
        slug.includes("-online-espanol")
      ) {
        provider = "repelishd";

      } else {
        provider = "pelisplus";
      }
    }

    let data;
    let source = provider;

    try {
      let service;

      if (provider === "cuevana3") {
        service = cuevanaService;

      } else if (
        provider === "repelishd"
      ) {
        service = repelishdService;

      } else {
        service = pelisplusService;
      }

      data =
        await service.getEpisodeServers(
          slug,
          season,
          episode
        );

    } catch (error) {
      if (provider === "pelisplus") {
        try {
          console.log(
            `Cascading servers request to RePelisHD for slug: ${slug}`
          );

          data =
            await repelishdService.getEpisodeServers(
              slug,
              season,
              episode
            );

          source = "repelishd";

        } catch (repelisError) {
          try {
            console.log(
              `Cascading servers request to Cuevana3 for slug: ${slug}`
            );

            data =
              await cuevanaService.getEpisodeServers(
                slug,
                season,
                episode
              );

            source = "cuevana3";

          } catch (cascadeError) {
            console.error(
              "Cuevana3 cascade failed too:",
              cascadeError.message
            );

            throw error;
          }
        }

      } else {
        throw error;
      }
    }

    res.status(200).json({
      success: true,
      data,
      source,
    });
  })
);

/**
 * Resolver embed
 */
router.get(
  "/resolve",
  asyncHandler(async (req, res) => {
    const embedUrl =
      req.query.url;

    const parentUrl =
      req.query.parentUrl || null;

    if (!embedUrl) {
      throw new ApiError(
        400,
        "Se requiere el parametro 'url' del embed"
      );
    }

    const directUrl =
      await resolveEmbedUrl(
        embedUrl,
        parentUrl
      );

    res.status(200).json({
      success: true,

      data: {
        embedUrl,
        directUrl,
      },

      source: "pelisplus",
    });
  })
);

/**
 * Descargar
 */
router.post(
  "/download",
  asyncHandler(async (req, res) => {
    const baseUrl =
      `${req.protocol}://${req.get("host")}`;

    const data =
      downloadService.createDownload(
        req.body || {},
        baseUrl
      );

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Estado de descarga
 */
router.get(
  "/download/:id",
  asyncHandler(async (req, res) => {
    const data =
      downloadService.getDownload(
        req.params.id
      );

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Descarga batch
 */
router.post(
  "/batch",
  asyncHandler(async (req, res) => {
    const baseUrl =
      `${req.protocol}://${req.get("host")}`;

    const data =
      downloadService.createBatch(
        req.body || {},
        baseUrl
      );

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

/**
 * Estado batch
 */
router.get(
  "/batch/:id",
  asyncHandler(async (req, res) => {
    const data =
      downloadService.getBatch(
        req.params.id
      );

    res.status(200).json({
      success: true,
      data,
      source: "pelisplus",
    });
  })
);

module.exports = router;
