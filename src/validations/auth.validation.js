/**
 * src/validations/auth.validation.js
 * =============================================================================
 * Schema Joi untuk endpoint auth.
 * =============================================================================
 */

const Joi = require('joi');

const loginSchema = Joi.object({
  username: Joi.string().trim().min(3).max(50).required()
    .messages({ 'any.required': 'Username wajib diisi', 'string.empty': 'Username wajib diisi' }),
  password: Joi.string().min(1).max(255).required()
    .messages({ 'any.required': 'Password wajib diisi', 'string.empty': 'Password wajib diisi' }),
});

module.exports = { loginSchema };
