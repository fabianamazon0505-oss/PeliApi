const express = require("express");
const rateLimit = require("express-rate-limit");
const { resolveEmbedUrl } = require("../utils/resolvers");
const { proxyUrlFor, proxySignedMedia } = require("../utils/hls-proxy");

const router = express.Router();

const resolveLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Demasiadas resoluciones HLS. Espera 1 minuto." },
});

// Resuelve el iframe y devuelve URL directa + URL proxificada para Roku.
// GET /api/hls/resolve?url=https://streamwish.to/e/xxx
router.get("/resolve", resolveLimiter, async (req, res, next) => {
  try {
    const embedUrl = req.query.url;
    const parentUrl = req.query.parentUrl || null;

    if (!embedUrl) {
      return res.status(400).json({
        success: false,
        message: "Se requiere el parámetro 'url' del embed",
      });
    }

    const directUrl = await resolveEmbedUrl(embedUrl, parentUrl);
    if (!directUrl) {
      return res.status(502).json({
        success: false,
        message: "No se pudo resolver el stream directo",
      });
    }

    const proxyUrl = proxyUrlFor(req, directUrl, embedUrl);

    res.status(200).json({
      success: true,
      data: {
        embedUrl,
        directUrl,
        proxyUrl,
      },
      source: "pelisplus",
    });
  } catch (error) {
    next(error);
  }
});

// Proxy firmado. Las URLs sólo pueden generarse desde el propio servidor.
// GET /api/hls/p/:token
router.get("/p/:token", async (req, res, next) => {
  try {
    await proxySignedMedia(req, res, req.params.token);
  } catch (error) {
    if (res.headersSent) {
      try { res.end(); } catch (_e) {}
      return;
    }
    next(error);
  }
});

module.exports = router;
