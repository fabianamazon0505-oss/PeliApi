/**
 * Obtener catálogo filtrado por tipo, género y página
 * GET /catalog?type=movie&genre=accion&page=1
 */
router.get(
  "/catalog",
  asyncHandler(async (req, res) => {
    const type = req.query.type || "movie";
    const genre = req.query.genre || "";
    const page = Number(req.query.page || 1);

    let data;
    let source = "pelisplus";

    try {
      console.log(
        `[CATALOG] Intentando PelisPlus: type=${type} page=${page}`
      );

      data = await pelisplusService.getCatalog(
        type,
        genre,
        page
      );

      if (data && data.items) {
        data.items = data.items.map(item => ({
          ...item,
          provider: "pelisplus"
        }));
      }

      console.log(
        `[CATALOG] PelisPlus OK: ${data?.items?.length || 0} items`
      );

    } catch (error) {
      console.error(
        `[CATALOG] PelisPlus falló: ${error.message}`
      );

      /*
       * RePelisHD actualmente lo usamos como
       * fallback para películas.
       */
      if (type === "movie") {
        console.log(
          `[CATALOG] Usando RePelisHD como fallback`
        );

        data = await repelishdService.getCatalog(
          type,
          genre,
          page
        );

        source = "repelishd";

        if (data && data.items) {
          data.items = data.items.map(item => ({
            ...item,
            provider: "repelishd"
          }));
        }

        console.log(
          `[CATALOG] RePelisHD OK: ${data?.items?.length || 0} items`
        );

      } else {
        /*
         * RePelisHD todavía no tiene catálogo
         * de series/anime implementado.
         */
        throw error;
      }
    }

    res.status(200).json({
      success: true,
      data,
      source
    });
  })
);
