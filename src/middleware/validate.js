/**
 * src/middleware/validate.js
 * =============================================================================
 * Middleware validasi pakai Joi. Validasi body / params / query sesuai schema,
 * timpa req[bagian] dengan nilai yang sudah di-sanitize, lempar 422 kalau gagal.
 *
 * Pemakaian di route:
 *   router.post('/login', validate(loginSchema), authController.login);
 *   // atau validasi bagian tertentu:
 *   router.get('/:id', validate(idSchema, 'params'), ctrl.detail);
 * =============================================================================
 */

const { validation } = require('../helpers/errors');

function validate(schema, property = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
      abortEarly: false,   // kumpulkan semua error
      stripUnknown: true,  // buang field yang tidak didefinisikan
      convert: true,       // konversi tipe (mis. "1" -> 1)
    });

    if (error) {
      const details = error.details.map((d) => ({
        field: d.path.join('.'),
        message: d.message,
      }));
      return next(validation('Validasi gagal', details));
    }

    req[property] = value;
    next();
  };
}

module.exports = validate;
