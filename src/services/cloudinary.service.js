/**
 * src/services/cloudinary.service.js
 * =============================================================================
 * Upload bukti (transfer/belanja) ke Cloudinary -> return secure_url.
 * AMAN: kalau CLOUDINARY_URL kosong -> mode disabled (lempar error jelas saat
 * dipakai, tapi tidak crash saat load). Paket 'cloudinary' di-require lazy.
 *
 * uploadBukti(fileBuffer, { folder, publicId }) -> { url, public_id }
 * =============================================================================
 */

const logger = require('../config/logger');
const { badRequest } = require('../helpers/errors');

const ENABLED = !!process.env.CLOUDINARY_URL;
let cloudinary = null;

function getClient() {
  if (!ENABLED) return null;
  if (!cloudinary) {
    cloudinary = require('cloudinary').v2; // baca CLOUDINARY_URL dari env otomatis
  }
  return cloudinary;
}

function isEnabled() { return ENABLED; }

/**
 * Upload buffer gambar. Return { url, public_id }.
 * @param {Buffer} buffer  isi file (dari multer memoryStorage)
 * @param {object} opts { folder, publicId }
 */
async function uploadBukti(buffer, { folder = 'zlaundry/bukti', publicId = null } = {}) {
  const cl = getClient();
  if (!cl) throw badRequest('Upload bukti belum aktif (CLOUDINARY_URL belum diset)');

  return new Promise((resolve, reject) => {
    const stream = cl.uploader.upload_stream(
      { folder, public_id: publicId, resource_type: 'image' },
      (err, result) => {
        if (err) { logger.error('Cloudinary upload gagal', { err: err.message }); return reject(err); }
        resolve({ url: result.secure_url, public_id: result.public_id });
      }
    );
    stream.end(buffer);
  });
}

module.exports = { uploadBukti, isEnabled };
