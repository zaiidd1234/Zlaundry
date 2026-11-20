/**
 * src/services/karyawan.service.js
 * =============================================================================
 * Kelola karyawan oleh MANAGER (scope 1 cabang).
 * Manager HANYA boleh membuat/mengelola role: kasir, operator, kurir.
 * (TIDAK boleh manager/owner.)
 *
 * Operasi: daftar, tambah, edit (nama+role), aktif/nonaktif, reset password.
 * =============================================================================
 */

const { normalizeHp } = require('../helpers/phone');
const bcrypt = require('bcryptjs');
const karyawanModel = require('../models/karyawan.model');
const { badRequest, notFound, conflict, forbidden } = require('../helpers/errors');

// Role yang boleh dikelola manager
const ROLE_BOLEH = ['kasir', 'operator', 'kurir'];
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS) || 10;

/** Daftar karyawan cabang (tanpa owner/manager). */
async function daftar(cabangId) {
  return karyawanModel.findByCabangRole(cabangId, { excludeRoles: ['owner', 'manager'] });
}

function validRole(role) {
  if (!ROLE_BOLEH.includes(role)) {
    throw forbidden(`Role "${role}" tidak boleh dikelola di sini. Pilih: ${ROLE_BOLEH.join(', ')}`);
  }
}

/** Pastikan karyawan target ada, milik cabang ini, dan role-nya boleh dikelola. */
async function ambilTarget(id, cabangId) {
  const k = await karyawanModel.findById(id);
  if (!k) throw notFound('Karyawan tidak ditemukan');
  if (cabangId && k.cabang_id !== cabangId) throw conflict('Karyawan bukan dari cabang ini');
  validRole(k.role);
  return k;
}

/** Tambah karyawan baru. */
async function tambah(cabangId, { nama, username, role, password }) {
  nama = String(nama || '').trim();
  username = String(username || '').trim().toLowerCase();
  role = String(role || '').trim();
  if (!nama) throw badRequest('Nama wajib diisi');
  if (!username || username.length < 3) throw badRequest('Username minimal 3 karakter');
  if (!/^[a-z0-9._]+$/.test(username)) throw badRequest('Username hanya boleh huruf kecil, angka, titik, underscore');
  if (!password || String(password).length < 6) throw badRequest('Password minimal 6 karakter');
  validRole(role);

  if (await karyawanModel.usernameDipakai(username)) throw conflict('Username sudah dipakai');
  const roleId = await karyawanModel.roleIdByNama(role);
  if (!roleId) throw badRequest('Role tidak valid');

  const password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  const id = await karyawanModel.create({ cabang_id: cabangId, role_id: roleId, nama, username, password_hash, status: 'aktif' });
  return karyawanModel.findById(id);
}

/** Edit nama + role karyawan. */
async function edit(id, cabangId, { nama, role, telepon, jatah_cuci_mingguan }, aktorRole = 'manager') {
  await ambilTarget(id, cabangId);
  nama = String(nama || '').trim();
  role = String(role || '').trim();
  if (!nama) throw badRequest('Nama wajib diisi');
  validRole(role);
  const roleId = await karyawanModel.roleIdByNama(role);
  if (!roleId) throw badRequest('Role tidak valid');
  // Perubahan #39: nomor HP + nominal jatah cuci per minggu
  let hp;
  if (telepon !== undefined) {
    hp = normalizeHp(telepon) || null;
    if (hp && !/^08\d{8,12}$/.test(hp)) throw badRequest('Nomor HP tidak valid (contoh 08123456789)');
  }
  let jatah;
  // Perubahan #46: jatah cuci = keputusan owner; manager tidak boleh mengubah
  if (aktorRole !== 'owner') jatah_cuci_mingguan = undefined;
  if (jatah_cuci_mingguan !== undefined && jatah_cuci_mingguan !== null && jatah_cuci_mingguan !== '') {
    jatah = Math.round(Number(String(jatah_cuci_mingguan).replace(/[^\d]/g, '')));
    if (!Number.isFinite(jatah) || jatah < 0 || jatah > 1000000) throw badRequest('Nominal jatah cuci tidak valid');
  }
  await karyawanModel.updateData(id, { nama, role_id: roleId, telepon: hp, jatah_cuci_mingguan: jatah });
  return karyawanModel.findById(id);
}

/** Aktif / nonaktif karyawan. */
async function ubahStatus(id, cabangId, status) {
  if (!['aktif', 'nonaktif'].includes(status)) throw badRequest('Status tidak valid');
  await ambilTarget(id, cabangId);
  await karyawanModel.setStatus(id, status);
  return karyawanModel.findById(id);
}

/** Reset password karyawan. */
async function resetPassword(id, cabangId, password) {
  await ambilTarget(id, cabangId);
  if (!password || String(password).length < 6) throw badRequest('Password minimal 6 karakter');
  const password_hash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
  await karyawanModel.setPassword(id, password_hash);
  return { id, ok: true };
}

module.exports = { daftar, tambah, edit, ubahStatus, resetPassword, ROLE_BOLEH };
