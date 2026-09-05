const express = require("express");
const axios = require("axios");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const imageUrl = req.query.url;

    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        message: "Falta el parámetro url",
      });
    }

    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
      timeout: 15000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36",
        "Referer": "https://www.pelisplushd.la/",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      return res.status(502).json({
        success: false,
        message: `No se pudo obtener la imagen. HTTP ${response.status}`,
      });
    }

    const contentType =
      response.headers["content-type"] || "image/jpeg";

    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Cache-Control",
      "public, max-age=86400"
    );

    res.send(Buffer.from(response.data));
  } catch (error) {
    console.error("[IMAGE PROXY]", error.message);

    res.status(500).json({
      success: false,
      message: "Error cargando imagen",
    });
  }
});

module.exports = router;
