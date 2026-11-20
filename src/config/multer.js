/**
 * src/config/multer.js
 * =============================================================================
 * Multer memoryStorage: terima file upload ke buffer (lalu diteruskan ke
 * Cloudinary). Batas 5MB, hanya gambar (jpg/png/webp).
 * =============================================================================
 */

const multer = require('multer');
const { badRequest } = require('../helpers/errors');

const storage = multer.memoryStorage();

function fileFilter(req, file, cb) {
  if (/^image\/(jpe?g|png|webp)$/.test(file.mimetype)) cb(null, true);
  else cb(badRequest('File harus gambar (jpg/png/webp)'), false);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

module.exports = upload;
